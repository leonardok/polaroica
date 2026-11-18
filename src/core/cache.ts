/**
 * Local cache, one directory per library folder, kept on this computer (never on the share):
 *
 *   <cacheDir>/<sha1(folder path)>/index.json   folder listing, EXIF, thumbnail table
 *   <cacheDir>/<sha1(folder path)>/thumbs.bin   thumbnails, appended back to back
 *
 * Packing thumbnails into one file per folder saves disk (no 4 KB minimum block per tiny file)
 * and loads a folder's thumbnails with local reads only. Entries are keyed by file name plus the
 * photo's size and modified time, so an edited photo gets a new thumbnail. Whole folders are
 * evicted least-recently-used when the cache grows past its cap. No `vscode` import.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ExifInfo } from './exif';

const VERSION = 1;

export interface ListedPhoto {
  name: string;
  size: number;
  mtime: number;
}

export interface Listing {
  folders: string[];
  photos: ListedPhoto[];
  scannedAt: number;
}

interface ThumbEntry {
  size: number;
  mtime: number;
  off: number;
  len: number;
  w: number;
  h: number;
  px: number;
}

interface ExifEntry {
  size: number;
  mtime: number;
  info: ExifInfo | null;
}

interface IndexData {
  v: number;
  path: string;
  listing?: Listing;
  thumbs: Record<string, ThumbEntry>;
  exif: Record<string, ExifEntry>;
  packSize: number;
  garbage: number;
}

export interface Thumb {
  data: Buffer;
  w: number;
  h: number;
}

export class FolderCache {
  private data: IndexData;
  private saveTimer?: NodeJS.Timeout;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly folder: string,
    readonly dir: string,
    data: IndexData | undefined,
    private readonly onWrite: () => void,
  ) {
    this.data = data ?? { v: VERSION, path: folder, thumbs: {}, exif: {}, packSize: 0, garbage: 0 };
  }

  static async open(folder: string, dir: string, onWrite: () => void): Promise<FolderCache> {
    let data: IndexData | undefined;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(path.join(dir, 'index.json'), 'utf8')) as IndexData;
      if (parsed.v === VERSION && parsed.path === folder) {
        data = parsed;
        // A pack shorter than the index says (crash mid-write): drop the thumbnails.
        const st = await fs.promises.stat(path.join(dir, 'thumbs.bin')).catch(() => undefined);
        if ((st?.size ?? 0) < data.packSize) {
          data.thumbs = {};
          data.packSize = st?.size ?? 0;
          data.garbage = data.packSize;
        }
      }
    } catch {
      /* no index yet, or unreadable: start empty */
    }
    const fc = new FolderCache(folder, dir, data, onWrite);
    fc.touch();
    return fc;
  }

  // ---- listing ----

  get listing(): Listing | undefined {
    return this.data.listing;
  }

  setListing(listing: Listing): void {
    this.data.listing = listing;
    // Forget thumbnails / EXIF of photos that are gone.
    const names = new Set(listing.photos.map((p) => p.name));
    for (const n of Object.keys(this.data.thumbs)) {
      if (!names.has(n)) {
        this.data.garbage += this.data.thumbs[n].len;
        delete this.data.thumbs[n];
      }
    }
    for (const n of Object.keys(this.data.exif)) {
      if (!names.has(n)) {
        delete this.data.exif[n];
      }
    }
    this.scheduleSave();
  }

  // ---- exif ----

  getExif(name: string, size: number, mtime: number): ExifInfo | null | undefined {
    const e = this.data.exif[name];
    return e && e.size === size && e.mtime === mtime ? e.info : undefined;
  }

  setExif(name: string, size: number, mtime: number, info: ExifInfo | undefined): void {
    this.data.exif[name] = { size, mtime, info: info ?? null };
    this.scheduleSave();
  }

  // ---- thumbnails ----

  hasThumb(name: string, size: number, mtime: number, px: number): boolean {
    const e = this.data.thumbs[name];
    return !!e && e.size === size && e.mtime === mtime && e.px === px;
  }

  get thumbCount(): number {
    return Object.keys(this.data.thumbs).length;
  }

  /** Reads several thumbnails with one open file handle. */
  async getThumbs(items: Array<{ name: string; size: number; mtime: number }>, px: number): Promise<Map<string, Thumb>> {
    const out = new Map<string, Thumb>();
    const wanted = items.filter((i) => this.hasThumb(i.name, i.size, i.mtime, px));
    if (!wanted.length) {
      return out;
    }
    await this.serial(async () => {
      const fh = await fs.promises.open(path.join(this.dir, 'thumbs.bin'), 'r').catch(() => undefined);
      if (!fh) {
        return;
      }
      try {
        for (const i of wanted) {
          const e = this.data.thumbs[i.name];
          if (!e) {
            continue;
          }
          const buf = Buffer.alloc(e.len);
          const { bytesRead } = await fh.read(buf, 0, e.len, e.off);
          if (bytesRead === e.len) {
            out.set(i.name, { data: buf, w: e.w, h: e.h });
          }
        }
      } finally {
        await fh.close();
      }
    });
    if (out.size) {
      this.touch();
    }
    return out;
  }

  async putThumb(name: string, size: number, mtime: number, px: number, t: Thumb): Promise<void> {
    await this.serial(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true });
      const old = this.data.thumbs[name];
      const off = this.data.packSize;
      await fs.promises.appendFile(path.join(this.dir, 'thumbs.bin'), t.data);
      this.data.packSize += t.data.length;
      if (old) {
        this.data.garbage += old.len;
      }
      this.data.thumbs[name] = { size, mtime, off, len: t.data.length, w: t.w, h: t.h, px };
    });
    this.scheduleSave();
    this.onWrite();
  }

  dropThumb(name: string): void {
    const e = this.data.thumbs[name];
    if (e) {
      this.data.garbage += e.len;
      delete this.data.thumbs[name];
      this.scheduleSave();
    }
  }

  /** Rewrites the pack without dead entries once they make up a large part of it. */
  async compactIfNeeded(): Promise<void> {
    if (this.data.garbage < 256 * 1024 || this.data.garbage < this.data.packSize * 0.3) {
      return;
    }
    await this.serial(async () => {
      const src = path.join(this.dir, 'thumbs.bin');
      const tmp = path.join(this.dir, 'thumbs.bin.tmp');
      const fh = await fs.promises.open(src, 'r');
      const parts: Buffer[] = [];
      let off = 0;
      try {
        for (const e of Object.values(this.data.thumbs)) {
          const buf = Buffer.alloc(e.len);
          await fh.read(buf, 0, e.len, e.off);
          parts.push(buf);
          e.off = off;
          off += e.len;
        }
      } finally {
        await fh.close();
      }
      await fs.promises.writeFile(tmp, Buffer.concat(parts));
      await fs.promises.rename(tmp, src);
      this.data.packSize = off;
      this.data.garbage = 0;
      await this.saveNow();
    });
  }

  get bytes(): number {
    return this.data.packSize;
  }

  /** Bytes of thumbnails still in use (pack minus replaced entries). */
  get liveBytes(): number {
    return Object.values(this.data.thumbs).reduce((s, e) => s + e.len, 0);
  }

  /** Marks the folder as recently used (eviction order). */
  touch(): void {
    const now = new Date();
    fs.promises.utimes(path.join(this.dir, 'index.json'), now, now).catch(() => undefined);
  }

  private scheduleSave(): void {
    if (this.saveTimer) {
      return;
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.serial(() => this.saveNow());
    }, 1500);
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    await this.serial(() => this.saveNow());
  }

  private async saveNow(): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, 'index.json.tmp');
    await fs.promises.writeFile(tmp, JSON.stringify(this.data));
    await fs.promises.rename(tmp, path.join(this.dir, 'index.json'));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

export interface CacheStats {
  folders: number;
  bytes: number;
  /** Average thumbnail size, measured over folders opened this session. */
  avgThumbBytes: number;
}

export class CacheManager {
  private readonly folders = new Map<string, Promise<FolderCache>>();
  private evictTimer?: NodeJS.Timeout;

  constructor(
    readonly dir: string,
    private capBytes: number,
  ) {}

  setCap(bytes: number): void {
    this.capBytes = bytes;
    this.scheduleEvict();
  }

  folder(folderPath: string): Promise<FolderCache> {
    const key = normalize(folderPath);
    let p = this.folders.get(key);
    if (!p) {
      p = FolderCache.open(key, path.join(this.dir, hash(key)), () => this.scheduleEvict());
      this.folders.set(key, p);
    }
    return p;
  }

  /** After a move: copy the thumbnail across folders so it isn't generated again. */
  async moveThumb(
    from: { folder: string; name: string; size: number; mtime: number },
    to: { folder: string; name: string; size: number; mtime: number },
    px: number,
  ): Promise<void> {
    const src = await this.folder(from.folder);
    const t = (await src.getThumbs([from], px)).get(from.name);
    src.dropThumb(from.name);
    if (t) {
      await (await this.folder(to.folder)).putThumb(to.name, to.size, to.mtime, px, t);
    }
  }

  async stats(): Promise<CacheStats> {
    const entries = await this.scan();
    let thumbs = 0;
    let thumbBytes = 0;
    for (const f of this.folders.values()) {
      const fc = await f;
      thumbs += fc.thumbCount;
      thumbBytes += fc.liveBytes;
    }
    return {
      folders: entries.length,
      bytes: entries.reduce((s, e) => s + e.bytes, 0),
      avgThumbBytes: thumbs ? thumbBytes / thumbs : 0,
    };
  }

  async clear(): Promise<void> {
    for (const f of this.folders.values()) {
      await (await f).flush().catch(() => undefined);
    }
    this.folders.clear();
    await fs.promises.rm(this.dir, { recursive: true, force: true });
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.folders.values()].map(async (f) => (await f).flush().catch(() => undefined)));
  }

  private scheduleEvict(): void {
    if (this.evictTimer) {
      return;
    }
    this.evictTimer = setTimeout(() => {
      this.evictTimer = undefined;
      void this.evict();
    }, 10000);
  }

  /** Deletes least-recently-used folders until the cache fits in its cap. */
  async evict(): Promise<number> {
    const entries = await this.scan();
    let total = entries.reduce((s, e) => s + e.bytes, 0);
    if (total <= this.capBytes) {
      return 0;
    }
    entries.sort((a, b) => a.used - b.used);
    let removed = 0;
    const target = this.capBytes * 0.9; // a little headroom so we don't evict on every write
    for (const e of entries) {
      if (total <= target) {
        break;
      }
      // Forget the in-memory handle for that folder so it starts fresh.
      for (const [k, p] of this.folders) {
        if (path.basename((await p).dir) === e.name) {
          this.folders.delete(k);
        }
      }
      await fs.promises.rm(path.join(this.dir, e.name), { recursive: true, force: true });
      total -= e.bytes;
      removed++;
    }
    return removed;
  }

  private async scan(): Promise<Array<{ name: string; bytes: number; used: number }>> {
    let names: string[];
    try {
      names = await fs.promises.readdir(this.dir);
    } catch {
      return [];
    }
    const out: Array<{ name: string; bytes: number; used: number }> = [];
    for (const name of names) {
      const d = path.join(this.dir, name);
      const [idx, pack] = await Promise.all([
        fs.promises.stat(path.join(d, 'index.json')).catch(() => undefined),
        fs.promises.stat(path.join(d, 'thumbs.bin')).catch(() => undefined),
      ]);
      if (!idx && !pack) {
        continue;
      }
      out.push({ name, bytes: (idx?.size ?? 0) + (pack?.size ?? 0), used: idx?.mtimeMs ?? 0 });
    }
    return out;
  }
}

function hash(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);
}

function normalize(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}
