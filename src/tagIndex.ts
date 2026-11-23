/**
 * Which photos carry which tags, for the whole set of libraries, so "show me everything tagged
 * Screenshot" is answered without reading a sidecar.
 *
 * The sidecars are the truth; this is a cache and can be thrown away. It lives in the extension's
 * global storage — never in the thumbnail cache, which is size-capped and evicted.
 *
 * On disk it's an append-only log, one JSON record per line: the last record for a path wins.
 * Appending is cheap and survives a crash mid-write (a torn last line is dropped on load). When
 * superseded lines take over half the file it's rewritten.
 */
import * as fs from 'fs';
import * as path from 'path';
import { normalizeTags, sameTag } from './core/xmp';

const VERSION = 1;
const FILE = 'tags.ndjson';

interface Record_ {
  /** Absolute path of the photo. */
  p: string;
  /** File size and modified time when it was tagged: a photo replaced since is stale. */
  s: number;
  m: number;
  /** All its tags. */
  t: string[];
  /** Which of them a scan wrote. */
  a?: string[];
}

export interface TagCount {
  tag: string;
  photos: number;
}

/** A photo as the index remembers it. */
export interface TaggedPhoto {
  fsPath: string;
  size: number;
  mtime: number;
  tags: string[];
}

export class TagIndex {
  /** path -> record. */
  private byPath = new Map<string, Record_>();
  /** lower-cased tag -> { shown: the tag as first written, paths }. */
  private byTag = new Map<string, { shown: string; paths: Set<string> }>();
  private lines = 0;
  private loaded?: Promise<void>;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  /**
   * Called after the set of tags, or what carries them, changed — including when a stale record is
   * dropped on read. The tree listens, so a count can't outlive the photos behind it.
   */
  onChanged?: () => void;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, FILE);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      let text: string;
      try {
        text = await fs.promises.readFile(this.file, 'utf8');
      } catch {
        return; // no index yet
      }
      const lines = text.split('\n');
      let head: { v?: number } | undefined;
      try {
        head = JSON.parse(lines[0] || '{}') as { v?: number };
      } catch {
        head = undefined;
      }
      if (head?.v !== VERSION) {
        // Written by another version: start empty and let a scan fill it in again.
        this.byPath.clear();
        this.byTag.clear();
        return;
      }
      for (const line of lines.slice(1)) {
        if (!line) {
          continue;
        }
        try {
          // A record with no tags is a deletion.
          const r = JSON.parse(line) as Record_;
          if (typeof r.p === 'string') {
            this.apply(r);
            this.lines++;
          }
        } catch {
          /* a torn last line (killed mid-append): ignore it */
        }
      }
    })();
    return this.loaded;
  }

  /** Puts a record into the two maps, replacing any earlier one for the same path. */
  private apply(r: Record_): void {
    const old = this.byPath.get(r.p);
    if (old) {
      for (const t of old.t) {
        const e = this.byTag.get(t.toLowerCase());
        e?.paths.delete(r.p);
        if (e && !e.paths.size) {
          this.byTag.delete(t.toLowerCase());
        }
      }
    }
    if (!r.t.length) {
      this.byPath.delete(r.p);
      return;
    }
    this.byPath.set(r.p, r);
    for (const t of r.t) {
      const k = t.toLowerCase();
      const e = this.byTag.get(k);
      if (e) {
        e.paths.add(r.p);
      } else {
        this.byTag.set(k, { shown: t, paths: new Set([r.p]) });
      }
    }
  }

  /** Records a photo's tags. An empty list forgets it. */
  async set(fsPath: string, size: number, mtime: number, tags: readonly string[], autoTags?: readonly string[]): Promise<void> {
    await this.load();
    const t = normalizeTags(tags);
    const a = normalizeTags(autoTags ?? []).filter((x) => t.some((y) => sameTag(x, y)));
    const r: Record_ = { p: fsPath, s: size, m: mtime, t, ...(a.length ? { a } : {}) };
    const before = this.byPath.get(fsPath);
    if (before && before.s === size && before.m === mtime && same(before.t, t) && same(before.a ?? [], a)) {
      return; // nothing changed: don't grow the log
    }
    this.apply(r);
    await this.append(r);
    this.onChanged?.();
  }

  /** Forgets a photo (deleted, or moved away). */
  async forget(fsPath: string): Promise<void> {
    await this.load();
    if (!this.byPath.has(fsPath)) {
      return;
    }
    this.apply({ p: fsPath, s: 0, m: 0, t: [] });
    await this.append({ p: fsPath, s: 0, m: 0, t: [] });
    this.onChanged?.();
  }

  /** Every tag in use, most-used first. */
  async allTags(): Promise<TagCount[]> {
    await this.load();
    return [...this.byTag.values()]
      .map((e) => ({ tag: e.shown, photos: e.paths.size }))
      .sort((a, b) => b.photos - a.photos || a.tag.localeCompare(b.tag));
  }

  /**
   * Photos carrying a tag. Records whose file is gone, or whose size/time no longer match, are
   * dropped here rather than returned — so a replaced photo doesn't keep a tag it never had.
   */
  async photosWithTag(tag: string): Promise<TaggedPhoto[]> {
    await this.load();
    const e = this.byTag.get(tag.trim().toLowerCase());
    if (!e) {
      return [];
    }
    const out: TaggedPhoto[] = [];
    const stale: string[] = [];
    for (const p of [...e.paths]) {
      const r = this.byPath.get(p);
      if (!r) {
        continue;
      }
      const st = await fs.promises.stat(p).catch(() => undefined);
      if (!st || st.size !== r.s || Math.round(st.mtimeMs) !== r.m) {
        stale.push(p);
        continue;
      }
      out.push({ fsPath: p, size: r.s, mtime: r.m, tags: r.t });
    }
    for (const p of stale) {
      await this.forget(p);
    }
    return out.sort((a, b) => a.fsPath.localeCompare(b.fsPath));
  }

  /** The tags the index has for a photo (no freshness check). */
  async tagsOf(fsPath: string): Promise<string[]> {
    await this.load();
    return this.byPath.get(fsPath)?.t ?? [];
  }

  /** Forgets every photo under a folder (the library was removed, the folder moved away). */
  async forgetUnder(folder: string): Promise<void> {
    await this.load();
    const prefix = folder.endsWith(path.sep) ? folder : folder + path.sep;
    for (const p of [...this.byPath.keys()]) {
      if (p === folder || p.startsWith(prefix)) {
        await this.forget(p);
      }
    }
  }

  private append(r: Record_): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true });
      if (!this.lines) {
        await fs.promises.appendFile(this.file, JSON.stringify({ v: VERSION }) + '\n', 'utf8');
      }
      await fs.promises.appendFile(this.file, JSON.stringify(r) + '\n', 'utf8');
      this.lines++;
      if (this.lines > 256 && this.lines > this.byPath.size * 2) {
        await this.compact();
      }
    });
    return this.writing.then(() => undefined);
  }

  /** Rewrites the log with one line per photo. */
  private async compact(): Promise<void> {
    const tmp = this.file + '.tmp';
    const body = [JSON.stringify({ v: VERSION }), ...[...this.byPath.values()].map((r) => JSON.stringify(r))].join('\n') + '\n';
    await fs.promises.writeFile(tmp, body, 'utf8');
    await fs.promises.rename(tmp, this.file);
    this.lines = this.byPath.size;
  }

  /** Waits for every queued write (tests, and shutdown). */
  async flush(): Promise<void> {
    await this.writing;
  }
}

function same(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
