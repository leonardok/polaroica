import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Thumb } from './core/cache';
import { embeddedPreviews, embeddedThumbnail, isBrowserJpeg, readExif } from './core/exif';
import { isDisplayable, isRaw } from './core/images';
import { Photo, PhotoStore, readHead, readRange } from './photoStore';

/** Long edge of generated thumbnails, in pixels. */
export function thumbPx(): number {
  const v = vscode.workspace.getConfiguration('vsphoto').get<number>('thumbnailSize', 256);
  return [192, 256, 320].includes(v) ? v : 256;
}

export interface ThumbItem {
  name: string;
  data: Uint8Array;
  mime: string;
  /** 'thumb' = cached/generated; 'placeholder' = small EXIF thumbnail until the real one is in. */
  kind: 'thumb' | 'placeholder';
}

/** The webview side of thumbnail work: shows them, and decodes + shrinks photos for us. */
export interface ThumbSink {
  send(items: ThumbItem[]): void;
  decode(name: string, data: Uint8Array, mime: string, px: number): Promise<Thumb | undefined>;
  /** Only work for sinks that are on screen. */
  readonly active: boolean;
}

/** Caps parallel reads from the share across all open grids. */
class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

const HEAD_BYTES = 128 * 1024;
const RAW_HEAD_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;

/**
 * Makes and serves thumbnails. Cached ones come from the local pack file (no network). Missing
 * ones get, first, the small preview embedded in the photo's EXIF (one 128 KB read), then a
 * proper thumbnail decoded by the webview from the photo (one full read, only ever once).
 */
export class ThumbService {
  private readonly heads = new Limiter(4);
  private readonly fulls = new Limiter(2);

  constructor(private readonly store: PhotoStore) {}

  job(folder: vscode.Uri, sink: ThumbSink): ThumbJob {
    return new ThumbJob(this, folder, sink);
  }

  /** Cached thumbnails for some photos of one folder (local reads only). */
  async cached(folder: vscode.Uri, photos: Photo[]): Promise<Map<string, Thumb>> {
    const fc = await this.store.cache.folder(folder.fsPath);
    return fc.getThumbs(photos, thumbPx());
  }

  /** The EXIF thumbnail (JPEG) or, for RAW, nothing (its previews are large). */
  async placeholder(photo: Photo): Promise<Uint8Array | undefined> {
    if (isRaw(photo.name) || !isDisplayable(photo.name)) {
      return undefined;
    }
    return this.heads.run(async () => {
      const head = await readHead(photo.uri.fsPath, HEAD_BYTES).catch(() => undefined);
      if (!head) {
        return undefined;
      }
      const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
      if (fc.getExif(photo.name, photo.size, photo.mtime) === undefined) {
        fc.setExif(photo.name, photo.size, photo.mtime, readExif(head));
      }
      const r = embeddedThumbnail(head);
      return r ? head.slice(r.offset, r.offset + r.length) : undefined;
    });
  }

  /** Bytes a browser can draw for this photo: the file itself, or a RAW file's preview JPEG. */
  async source(photo: Photo): Promise<{ data: Uint8Array; mime: string } | undefined> {
    return this.fulls.run(async () => {
      if (isRaw(photo.name)) {
        const data = await rawPreview(photo.uri.fsPath);
        return data ? { data, mime: 'image/jpeg' } : undefined;
      }
      if (!isDisplayable(photo.name) || photo.size > MAX_SOURCE_BYTES) {
        return undefined;
      }
      const data = await fs.promises.readFile(photo.uri.fsPath).catch(() => undefined);
      return data ? { data, mime: mimeOf(photo.name) } : undefined;
    });
  }

  async save(photo: Photo, t: Thumb): Promise<void> {
    const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
    await fc.putThumb(photo.name, photo.size, photo.mtime, thumbPx(), t);
  }

  async has(photo: Photo): Promise<boolean> {
    const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
    return fc.hasThumb(photo.name, photo.size, photo.mtime, thumbPx());
  }

  async compact(folder: vscode.Uri): Promise<void> {
    await (await this.store.cache.folder(folder.fsPath)).compactIfNeeded().catch(() => undefined);
  }
}

/** The thumbnail work for one open grid: visible photos first, then the rest of the folder. */
export class ThumbJob {
  private photos: Photo[] = [];
  private visible: string[] = [];
  private readonly sent = new Map<string, 'thumb' | 'placeholder'>();
  private readonly failed = new Set<string>();
  private readonly inflight = new Set<string>();
  private disposed = false;
  private pumping = false;

  constructor(
    private readonly service: ThumbService,
    private readonly folder: vscode.Uri,
    private readonly sink: ThumbSink,
  ) {}

  setPhotos(photos: Photo[]): void {
    this.photos = photos;
    // A changed photo (new size/mtime) needs a new thumbnail.
    this.sent.clear();
    this.failed.clear();
    void this.pump();
  }

  setVisible(names: string[]): void {
    this.visible = names;
    void this.pump();
  }

  resume(): void {
    void this.pump();
  }

  dispose(): void {
    this.disposed = true;
    void this.service.compact(this.folder);
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (!this.disposed && this.sink.active) {
        const byName = new Map(this.photos.map((p) => [p.name, p]));
        const visible = this.visible.map((n) => byName.get(n)).filter((p): p is Photo => !!p);

        // 1. Cached thumbnails for what's on screen: local, so send them all at once.
        const unsent = visible.filter((p) => this.sent.get(p.name) !== 'thumb');
        if (unsent.length) {
          const cached = await this.service.cached(this.folder, unsent);
          if (cached.size) {
            this.sink.send(
              [...cached].map(([name, t]) => ({ name, data: t.data, mime: 'image/webp', kind: 'thumb' as const })),
            );
            for (const name of cached.keys()) {
              this.sent.set(name, 'thumb');
            }
          }
        }

        // 2. Next task: placeholder for a visible photo, else a real thumbnail (visible first).
        const needs = (p: Photo) => this.sent.get(p.name) !== 'thumb' && !this.failed.has(p.name) && !this.inflight.has(p.name);
        const placeholderFor = visible.find((p) => needs(p) && !this.sent.has(p.name));
        const thumbFor = visible.find(needs) ?? this.photos.find(needs);
        if (!placeholderFor && !thumbFor) {
          break;
        }
        if (this.inflight.size >= 3) {
          break; // the in-flight tasks call pump() again when they finish
        }
        const task = placeholderFor ? this.placeholder(placeholderFor) : this.generate(thumbFor!);
        const name = (placeholderFor ?? thumbFor)!.name;
        this.inflight.add(name);
        void task.finally(() => {
          this.inflight.delete(name);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async placeholder(p: Photo): Promise<void> {
    const data = await this.service.placeholder(p);
    if (this.disposed) {
      return;
    }
    if (data && !this.sent.has(p.name)) {
      this.sink.send([{ name: p.name, data, mime: 'image/jpeg', kind: 'placeholder' }]);
    }
    if (!this.sent.has(p.name)) {
      this.sent.set(p.name, 'placeholder');
    }
  }

  private async generate(p: Photo): Promise<void> {
    if (await this.service.has(p)) {
      const t = (await this.service.cached(this.folder, [p])).get(p.name);
      if (t) {
        this.sink.send([{ name: p.name, data: t.data, mime: 'image/webp', kind: 'thumb' }]);
        this.sent.set(p.name, 'thumb');
        return;
      }
    }
    const src = await this.service.source(p);
    if (!src || this.disposed) {
      this.failed.add(p.name);
      return;
    }
    const t = await this.sink.decode(p.name, src.data, src.mime, thumbPx()).catch(() => undefined);
    if (!t || this.disposed) {
      this.failed.add(p.name);
      return;
    }
    await this.service.save(p, t);
    this.sink.send([{ name: p.name, data: t.data, mime: 'image/webp', kind: 'thumb' }]);
    this.sent.set(p.name, 'thumb');
  }
}

/** The largest browser-decodable JPEG preview embedded in a RAW file. */
export async function rawPreview(fsPath: string): Promise<Uint8Array | undefined> {
  const head = await readHead(fsPath, RAW_HEAD_BYTES).catch(() => undefined);
  if (!head) {
    return undefined;
  }
  for (const r of embeddedPreviews(head)) {
    if (r.length > MAX_SOURCE_BYTES) {
      continue;
    }
    const bytes =
      r.offset + r.length <= head.length
        ? head.slice(r.offset, r.offset + r.length)
        : await readRange(fsPath, r.offset, r.length).catch(() => undefined);
    if (bytes && bytes.length === r.length && isBrowserJpeg(bytes)) {
      return bytes;
    }
  }
  return undefined;
}

export function mimeOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  switch (ext) {
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'avif':
      return 'image/avif';
    case 'bmp':
      return 'image/bmp';
    case 'svg':
      return 'image/svg+xml';
    case 'ico':
      return 'image/x-icon';
    default:
      return 'image/jpeg';
  }
}
