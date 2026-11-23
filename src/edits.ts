import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager } from './core/cache';
import {
  AutoRank,
  Edits,
  emptySidecar,
  Flag,
  isDefault,
  isEmptySidecar,
  normalizeTags,
  readSidecar,
  sameTag,
  Sidecar,
  SIDECAR_DIR,
  sidecarName,
  toXmp,
} from './core/xmp';
import { mapLimit } from './photoStore';

/** What the grid and filmstrip need to know about a photo's sidecar. */
export interface CullInfo {
  rating: number;
  flag?: Flag;
  auto?: AutoRank;
  edited: boolean;
  /** Keywords from the sidecar's `dc:subject`, in the order written. */
  tags?: string[];
  /** Which of `tags` a scan wrote rather than a person. */
  autoTags?: string[];
}

/** Tags to add and remove on a set of photos. */
export interface TagChange {
  add?: readonly string[];
  remove?: readonly string[];
  /**
   * The change comes from a scan: the added tags are marked automatic, and a scan may drop the
   * automatic tags it no longer stands behind (`replaceAuto`). A change without this is "yours",
   * and the tags it adds are never removed by a later scan.
   */
  auto?: boolean;
  /** With `auto`: drop every automatic tag this photo had that isn't being added again. */
  replaceAuto?: boolean;
}

export interface RatingChange {
  rating?: number;
  /** null clears the flag. */
  flag?: Flag | null;
  /** Set by Auto-Rank; any change without it is "yours" and clears the Auto-Rank mark. */
  auto?: AutoRank | null;
}

const CULL_KEY = 'culling-v2';

/**
 * Sidecars next to the photos: `<folder>/.sidecar/<photo>.xmp`, holding edits, star rating,
 * pick/reject flag and Auto-Rank details. The photo file itself is never written. A sidecar
 * left with nothing in it is removed (and the folder once it's empty).
 *
 * Reading every sidecar of a big folder over a network share is slow, so each folder's ratings
 * are also kept in the local index, keyed by the `.sidecar` folder's modified time (every write
 * here replaces a file, which updates it).
 */
export class EditStore {
  private readonly folders = new Map<string, Promise<Map<string, CullInfo>>>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** Fires with a photo whose sidecar changed. */
  readonly onDidChange = this.changed.event;
  /** Settings copied with "Copy Settings", shared by all photo tabs. */
  clipboard: Edits | undefined;

  constructor(private readonly cache?: CacheManager) {}

  sidecarPath(photo: vscode.Uri): string {
    return path.join(path.dirname(photo.fsPath), SIDECAR_DIR, sidecarName(path.basename(photo.fsPath)));
  }

  async loadSidecar(photo: vscode.Uri): Promise<Sidecar | undefined> {
    try {
      return readSidecar(await fs.promises.readFile(this.sidecarPath(photo), 'utf8'));
    } catch {
      return undefined;
    }
  }

  /** The photo's edits, if it has a sidecar. */
  async load(photo: vscode.Uri): Promise<Edits | undefined> {
    return (await this.loadSidecar(photo))?.edits;
  }

  /** Saves edits, keeping the rating and flag. */
  async save(photo: vscode.Uri, edits: Edits): Promise<void> {
    const sc = (await this.loadSidecar(photo)) ?? emptySidecar();
    sc.edits = edits;
    await this.write(photo, sc);
  }

  /** Sets rating / flag on several photos (all in one folder or not). */
  async rate(photos: vscode.Uri[], change: RatingChange): Promise<void> {
    await mapLimit(photos, 6, async (photo) => {
      const sc = (await this.loadSidecar(photo)) ?? emptySidecar();
      if (change.rating !== undefined) {
        sc.rating = Math.max(0, Math.min(5, Math.round(change.rating)));
      }
      if (change.flag !== undefined) {
        sc.flag = change.flag ?? undefined;
      }
      if (change.auto !== undefined) {
        sc.auto = change.auto ?? undefined;
      } else if (change.rating !== undefined || change.flag !== undefined) {
        sc.auto = undefined; // you rated it: no longer an Auto-Rank result
      }
      await this.write(photo, sc);
    });
  }

  /**
   * Adds and removes keywords on several photos (in one folder or not). Returns each photo's tags
   * as they now stand, so the caller can update the index without reading the sidecars again.
   */
  async tag(photos: vscode.Uri[], change: TagChange): Promise<Map<string, string[]>> {
    const add = normalizeTags(change.add ?? []);
    const remove = normalizeTags(change.remove ?? []);
    const out = new Map<string, string[]>();
    await mapLimit(photos, 6, async (photo) => {
      const sc = (await this.loadSidecar(photo)) ?? emptySidecar();
      const was = sc.tags ?? [];
      const wasAuto = sc.autoTags ?? [];
      // A scan may drop its own earlier guesses, never a tag added by hand.
      const dropped = change.auto && change.replaceAuto ? wasAuto.filter((t) => !add.some((a) => sameTag(a, t))) : [];
      const gone = [...remove, ...dropped];
      const kept = was.filter((t) => !gone.some((g) => sameTag(g, t)));
      const tags = normalizeTags([...kept, ...add]);
      const auto = normalizeTags([
        // A tag you add by hand stops being automatic, even if a scan put it there first.
        ...wasAuto.filter((t) => tags.some((x) => sameTag(x, t)) && !(!change.auto && add.some((a) => sameTag(a, t)))),
        ...(change.auto ? add : []),
      ]).filter((t) => tags.some((x) => sameTag(x, t)));
      sc.tags = tags.length ? tags : undefined;
      sc.autoTags = auto.length ? auto : undefined;
      await this.write(photo, sc);
      out.set(photo.fsPath, tags);
    });
    return out;
  }

  /** The photo's keywords. */
  async tagsOf(photo: vscode.Uri): Promise<string[]> {
    return (await this.loadSidecar(photo))?.tags ?? [];
  }

  /** Keywords of every photo in a folder that has any (photo file name -> tags). */
  async tagsIn(folder: string): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    for (const [name, c] of await this.cullingIn(folder)) {
      if (c.tags?.length) {
        map.set(name, c.tags);
      }
    }
    return map;
  }

  /** Writes a whole sidecar (Auto-Rank undo restores earlier ones this way). */
  async write(photo: vscode.Uri, sc: Sidecar): Promise<void> {
    const file = this.sidecarPath(photo);
    const dir = path.dirname(file);
    const folder = path.dirname(photo.fsPath);
    const name = path.basename(photo.fsPath);
    if (isEmptySidecar(sc)) {
      await fs.promises.rm(file, { force: true });
      await fs.promises.rmdir(dir).catch(() => undefined); // only succeeds when empty
    } else {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, toXmp(sc), 'utf8');
      await fs.promises.rename(tmp, file);
    }
    const map = await this.cullingIn(folder);
    if (isEmptySidecar(sc)) {
      map.delete(name);
    } else {
      map.set(name, cullOf(sc));
    }
    await this.remember(folder, map);
    this.changed.fire(photo);
  }

  /** Ratings, flags and edit marks of every photo in a folder that has a sidecar. */
  cullingIn(folder: string): Promise<Map<string, CullInfo>> {
    let p = this.folders.get(folder);
    if (!p) {
      p = this.read(folder);
      this.folders.set(folder, p);
      p.catch(() => this.folders.delete(folder));
    }
    return p;
  }

  /** Names of photos in a folder that have edits. */
  async editedIn(folder: string): Promise<Set<string>> {
    const map = await this.cullingIn(folder);
    return new Set([...map].filter(([, c]) => c.edited).map(([n]) => n));
  }

  private async read(folder: string): Promise<Map<string, CullInfo>> {
    const dir = path.join(folder, SIDECAR_DIR);
    const st = await fs.promises.stat(dir).catch(() => undefined);
    if (!st) {
      return new Map();
    }
    const fc = this.cache ? await this.cache.folder(folder) : undefined;
    const saved = fc?.getExtra<{ mtime: number; entries: Array<[string, CullInfo]> }>(CULL_KEY);
    if (saved && saved.mtime === Math.round(st.mtimeMs)) {
      return new Map(saved.entries);
    }
    const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.xmp'));
    const map = new Map<string, CullInfo>();
    await mapLimit(files, 8, async (f) => {
      try {
        const sc = readSidecar(await fs.promises.readFile(path.join(dir, f), 'utf8'));
        map.set(f.slice(0, -4), cullOf(sc));
      } catch {
        /* unreadable sidecar: skip */
      }
    });
    await this.remember(folder, map);
    return map;
  }

  private async remember(folder: string, map: Map<string, CullInfo>): Promise<void> {
    if (!this.cache) {
      return;
    }
    const st = await fs.promises.stat(path.join(folder, SIDECAR_DIR)).catch(() => undefined);
    const fc = await this.cache.folder(folder);
    fc.setExtra(CULL_KEY, { mtime: st ? Math.round(st.mtimeMs) : 0, entries: [...map] });
  }

  /** After a photo moved: its sidecar goes along (renamed if the photo was). */
  async carry(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const src = this.sidecarPath(from);
    if (!(await exists(src))) {
      return;
    }
    const dest = this.sidecarPath(to);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.promises.rename(src, dest);
    } catch {
      await fs.promises.copyFile(src, dest);
      await fs.promises.rm(src, { force: true });
    }
    await fs.promises.rmdir(path.dirname(src)).catch(() => undefined);
    this.forget(path.dirname(from.fsPath));
    this.forget(path.dirname(to.fsPath));
  }

  forget(folder?: string): void {
    if (folder) {
      this.folders.delete(folder);
    } else {
      this.folders.clear();
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}

function cullOf(sc: Sidecar): CullInfo {
  return {
    rating: sc.rating,
    flag: sc.flag,
    auto: sc.auto,
    edited: !isDefault(sc.edits),
    tags: sc.tags?.length ? sc.tags : undefined,
    autoTags: sc.autoTags?.length ? sc.autoTags : undefined,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}
