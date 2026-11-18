import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { CacheManager, Listing, ListedPhoto } from './core/cache';
import { ExifInfo, readExif } from './core/exif';
import { compareNames, isHiddenFolder, isPhoto, PhotoEntry, sortPhotos, SortKey } from './core/images';

export interface Photo extends PhotoEntry {
  uri: vscode.Uri;
}

export interface FolderListing {
  folders: string[];
  photos: Photo[];
  /** True while the listing comes from the local index and hasn't been re-checked yet. */
  cached: boolean;
}

/** Runs `fn` over `items` with at most `limit` in flight (network shares dislike floods). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Folder listings and EXIF, served from the local index first (instant, even for a slow share)
 * and re-checked against the disk in the background.
 */
export class PhotoStore implements vscode.Disposable {
  private readonly listings = new Map<string, Promise<FolderListing>>();
  private readonly revalidated = new Map<string, Promise<void>>();
  /** Folders whose index may be out of date: next load scans the disk (reusing stats). */
  private readonly stale = new Set<string>();
  /** Bumped by a full refresh: folders loaded before it are rescanned with fresh stats. */
  private epoch = 0;
  private readonly loadedAt = new Map<string, number>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** Fires with a folder whose contents changed, or `undefined` for "everything". */
  readonly onDidChange = this.changed.event;

  constructor(readonly cache: CacheManager) {}

  listing(folder: vscode.Uri): Promise<FolderListing> {
    const key = folder.fsPath;
    let p = this.listings.get(key);
    if (!p) {
      p = this.load(folder);
      this.listings.set(key, p);
      p.catch(() => this.listings.delete(key));
    }
    return p;
  }

  async photos(folder: vscode.Uri, sort: SortKey = 'name'): Promise<Photo[]> {
    return sortPhotos((await this.listing(folder)).photos, sort);
  }

  /**
   * Re-check a folder against the disk. Shallow: list names only and stat just the new files
   * (cheap; used for tree counts). Deep: stat every photo to catch edited files (open grids).
   */
  revalidate(folder: vscode.Uri, deep: boolean): Promise<void> {
    const key = folder.fsPath + (deep ? '#deep' : '');
    let p = this.revalidated.get(key);
    if (!p) {
      p = this.doRevalidate(folder, deep).catch(() => undefined);
      this.revalidated.set(key, p);
    }
    return p;
  }

  async exif(file: vscode.Uri, size: number, mtime: number): Promise<ExifInfo | undefined> {
    const fc = await this.cache.folder(path.dirname(file.fsPath));
    const name = path.basename(file.fsPath);
    const cached = fc.getExif(name, size, mtime);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const info = await readHead(file.fsPath, 128 * 1024).then(readExif, () => undefined);
    fc.setExif(name, size, mtime, info);
    return info;
  }

  /** Refresh button: re-read a folder, including stats of every photo. */
  async recheck(folder: vscode.Uri): Promise<void> {
    this.revalidated.delete(folder.fsPath + '#deep');
    await this.revalidate(folder, true);
  }

  /** Drop what we know about a folder (or everything) and re-read from disk. */
  invalidate(folder?: vscode.Uri): void {
    if (folder) {
      this.stale.add(folder.fsPath);
      this.listings.delete(folder.fsPath);
      this.revalidated.delete(folder.fsPath);
      this.revalidated.delete(folder.fsPath + '#deep');
    } else {
      this.epoch++;
      this.listings.clear();
      this.revalidated.clear();
    }
    this.changed.fire(folder);
  }

  private async load(folder: vscode.Uri): Promise<FolderListing> {
    const fc = await this.cache.folder(folder.fsPath);
    const key = folder.fsPath;
    const refreshed = (this.loadedAt.get(key) ?? 0) < this.epoch;
    this.loadedAt.set(key, this.epoch);
    if (fc.listing && (refreshed || this.stale.has(key))) {
      // Changed by us (move, new folder) or a Refresh: read the disk now.
      this.stale.delete(key);
      const fresh = await scan(key, refreshed ? undefined : fc.listing);
      fc.setListing(fresh);
      this.revalidated.set(key, Promise.resolve());
      return toFolderListing(folder, fresh, false);
    }
    if (fc.listing) {
      // Instant answer from the index; check the share in the background.
      setTimeout(() => void this.revalidate(folder, false), 0);
      return toFolderListing(folder, fc.listing, true);
    }
    const fresh = await scan(folder.fsPath, undefined);
    fc.setListing(fresh);
    this.revalidated.set(folder.fsPath, Promise.resolve());
    return toFolderListing(folder, fresh, false);
  }

  private async doRevalidate(folder: vscode.Uri, deep: boolean): Promise<void> {
    const fc = await this.cache.folder(folder.fsPath);
    const before = fc.listing;
    const fresh = await scan(folder.fsPath, deep ? undefined : before);
    if (before && sameListing(before, fresh)) {
      return;
    }
    fc.setListing(fresh);
    this.listings.set(folder.fsPath, Promise.resolve(toFolderListing(folder, fresh, false)));
    this.changed.fire(folder);
  }

  dispose(): void {
    this.changed.dispose();
    void this.cache.flushAll();
  }
}

function toFolderListing(folder: vscode.Uri, l: Listing, cached: boolean): FolderListing {
  return {
    folders: l.folders,
    photos: l.photos.map((p) => ({ ...p, uri: vscode.Uri.file(path.join(folder.fsPath, p.name)) })),
    cached,
  };
}

/** Lists a folder. With `known`, files whose name is already known keep their old stat. */
async function scan(dir: string, known: Listing | undefined): Promise<Listing> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const folders: string[] = [];
  const photoNames: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!isHiddenFolder(e.name)) {
        folders.push(e.name);
      }
    } else if ((e.isFile() || e.isSymbolicLink()) && isPhoto(e.name)) {
      photoNames.push(e.name);
    }
  }
  folders.sort(compareNames);
  const old = new Map((known?.photos ?? []).map((p) => [p.name, p]));
  const photos = (
    await mapLimit(photoNames, 16, async (name): Promise<ListedPhoto | undefined> => {
      const prev = old.get(name);
      if (prev) {
        return prev;
      }
      try {
        const st = await fs.promises.stat(path.join(dir, name));
        return st.isFile() ? { name, size: st.size, mtime: Math.round(st.mtimeMs) } : undefined;
      } catch {
        return undefined;
      }
    })
  ).filter((p): p is ListedPhoto => p !== undefined);
  photos.sort((a, b) => compareNames(a.name, b.name));
  return { folders, photos, scannedAt: Date.now() };
}

function sameListing(a: Listing, b: Listing): boolean {
  if (a.folders.length !== b.folders.length || a.photos.length !== b.photos.length) {
    return false;
  }
  if (a.folders.some((f, i) => f !== b.folders[i])) {
    return false;
  }
  return a.photos.every((p, i) => {
    const q = b.photos[i];
    return p.name === q.name && p.size === q.size && p.mtime === q.mtime;
  });
}

export async function readHead(fsPath: string, bytes: number): Promise<Uint8Array> {
  return readRange(fsPath, 0, bytes);
}

export async function readRange(fsPath: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(fsPath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function isReachable(fsPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(fsPath)).isDirectory();
  } catch {
    return false;
  }
}

export function sortSetting(): SortKey {
  const v = vscode.workspace.getConfiguration('vsphoto').get<string>('sortBy', 'name');
  return v === 'modified' || v === 'size' ? v : 'name';
}
