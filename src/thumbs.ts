import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { QUICK_PX, Thumb } from './core/cache';
import { makeThumb } from './core/codec';
import { embeddedPreviews, embeddedThumbnail, isBrowserJpeg, mpfPreviews, readExif } from './core/exif';
import { extensionOf, isDisplayable, isRaw } from './core/images';
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
  /** 'thumb' = sharp; 'placeholder' = quick one from the small EXIF preview, shown softened. */
  kind: 'thumb' | 'placeholder';
}

/** The webview side of a grid: shows thumbnails; decodes formats the codec can't (PNG, WebP…). */
export interface ThumbSink {
  send(items: ThumbItem[]): void;
  decode(name: string, data: Uint8Array, mime: string, px: number): Promise<Thumb | undefined>;
  readonly active: boolean;
}

/** Caps parallel reads from the share. */
export class Limiter {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  get busy(): number {
    return this.running + this.waiting.length;
  }
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

// EXIF (APP1) is at most 64 KB and the MPF index (APP2) follows it: 72 KB covers both.
const HEAD_BYTES = 72 * 1024;
const RAW_HEAD_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

export type SharpSource = 'preview' | 'full' | 'raw-preview' | 'webview';

/**
 * Makes and serves thumbnails, kept in the local cache. Two kinds:
 *  - quick: the ~160 px thumbnail cameras store in EXIF (one 128 KB read), cropped and rotated;
 *  - sharp: from the ~1600 px preview many cameras store in the JPEG (MPF), else the full file.
 * Decoding runs in the extension host with WebAssembly codecs.
 */
export class ThumbService {
  /** Reads for what's on screen: always first. */
  readonly fgHeads = new Limiter(4);
  readonly fgFulls = new Limiter(2);
  /** How the sharp thumbnails were made, for the progress display. */
  readonly sources: Record<SharpSource, number> = { preview: 0, full: 0, 'raw-preview': 0, webview: 0 };

  constructor(readonly store: PhotoStore) {}

  /** True while open grids are reading from the share; background work waits. */
  get foregroundBusy(): boolean {
    return this.fgHeads.busy + this.fgFulls.busy > 0;
  }

  job(folder: vscode.Uri, sink: ThumbSink): ThumbJob {
    return new ThumbJob(this, folder, sink);
  }

  /** Cached thumbnails (sharp, or quick ones as stand-ins) for photos of one folder: local reads. */
  async cached(folder: vscode.Uri, photos: Photo[]): Promise<Map<string, Thumb>> {
    const fc = await this.store.cache.folder(folder.fsPath);
    return fc.getThumbs(photos, thumbPx(), true);
  }

  async state(photo: Photo): Promise<'sharp' | 'quick' | 'none'> {
    const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
    if (fc.hasThumb(photo.name, photo.size, photo.mtime, thumbPx())) {
      return 'sharp';
    }
    return fc.hasThumb(photo.name, photo.size, photo.mtime, QUICK_PX) ? 'quick' : 'none';
  }

  /** Reads the start of the file (EXIF, MPF index) and remembers the EXIF. */
  private async head(photo: Photo, bytes: number): Promise<Uint8Array | undefined> {
    const head = await readHead(photo.uri.fsPath, bytes).catch(() => undefined);
    if (head) {
      const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
      if (fc.getExif(photo.name, photo.size, photo.mtime) === undefined) {
        fc.setExif(photo.name, photo.size, photo.mtime, readExif(head));
      }
    }
    return head;
  }

  /** Quick thumbnail from the EXIF preview; saved to the cache. */
  async quick(photo: Photo, limiter: Limiter): Promise<Thumb | undefined> {
    if (isRaw(photo.name) || !isJpeg(photo.name)) {
      return undefined;
    }
    const head = await limiter.run(() => this.head(photo, HEAD_BYTES));
    const r = head && embeddedThumbnail(head);
    if (!head || !r) {
      return undefined;
    }
    try {
      const t = await makeThumb(head.subarray(r.offset, r.offset + r.length), {
        px: thumbPx(),
        orientation: readExif(head)?.orientation,
        trim: true,
      });
      const thumb: Thumb = { data: t.data, w: t.w, h: t.h, quick: true };
      await this.save(photo, thumb, QUICK_PX);
      return thumb;
    } catch {
      return undefined;
    }
  }

  /**
   * Sharp thumbnail with the codec: the embedded preview when it is big enough, else the whole
   * file. Undefined when the codec can't read the format (the grid then asks its webview).
   */
  async sharp(photo: Photo, heads: Limiter, fulls: Limiter): Promise<Thumb | undefined> {
    const px = thumbPx();
    if (isRaw(photo.name)) {
      const head = await heads.run(() => this.head(photo, RAW_HEAD_BYTES));
      const data = head && (await fulls.run(() => rawPreviewFrom(photo.uri.fsPath, head)));
      return data ? this.finish(photo, data, readExif(head!)?.orientation, 'raw-preview') : undefined;
    }
    if (!isJpeg(photo.name)) {
      return undefined;
    }
    const head = await heads.run(() => this.head(photo, HEAD_BYTES));
    if (!head) {
      return undefined;
    }
    const orientation = readExif(head)?.orientation;
    for (const r of mpfPreviews(head)) {
      if (r.length > MAX_PREVIEW_BYTES || r.offset + r.length > photo.size) {
        continue;
      }
      const bytes = await fulls.run(() => readRange(photo.uri.fsPath, r.offset, r.length).catch(() => undefined));
      if (!bytes || bytes.length !== r.length || !isBrowserJpeg(bytes)) {
        continue;
      }
      const t = await makeThumb(bytes, { px, orientation }).catch(() => undefined);
      // A preview smaller than the thumbnail would look soft: use the full file instead.
      if (t && Math.max(t.sourceWidth, t.sourceHeight) >= px) {
        return this.store_(photo, t, 'preview');
      }
    }
    if (photo.size > MAX_SOURCE_BYTES) {
      return undefined;
    }
    const full = await fulls.run(() => fs.promises.readFile(photo.uri.fsPath).catch(() => undefined));
    return full ? this.finish(photo, full, orientation, 'full') : undefined;
  }

  private async finish(photo: Photo, jpeg: Uint8Array, orientation: number | undefined, source: SharpSource): Promise<Thumb | undefined> {
    const t = await makeThumb(jpeg, { px: thumbPx(), orientation }).catch(() => undefined);
    return t ? this.store_(photo, t, source) : undefined;
  }

  private async store_(photo: Photo, t: { data: Buffer; w: number; h: number }, source: SharpSource): Promise<Thumb> {
    const thumb: Thumb = { data: t.data, w: t.w, h: t.h };
    await this.save(photo, thumb, thumbPx());
    this.sources[source]++;
    return thumb;
  }

  /** The file's bytes, for the webview decoder (formats the codec can't read). */
  async source(photo: Photo): Promise<{ data: Uint8Array; mime: string } | undefined> {
    if (!isDisplayable(photo.name) || photo.size > MAX_SOURCE_BYTES) {
      return undefined;
    }
    const data = await this.fgFulls.run(() => fs.promises.readFile(photo.uri.fsPath).catch(() => undefined));
    return data ? { data, mime: mimeOf(photo.name) } : undefined;
  }

  async save(photo: Photo, t: Thumb, px = thumbPx()): Promise<void> {
    const fc = await this.store.cache.folder(path.dirname(photo.uri.fsPath));
    await fc.putThumb(photo.name, photo.size, photo.mtime, px, t);
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
  private readonly triedQuick = new Set<string>();
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

  /** A thumbnail was made elsewhere (background pass): show it if it's ours. */
  offer(photo: Photo, t: Thumb): void {
    if (this.disposed || path.dirname(photo.uri.fsPath) !== this.folder.fsPath) {
      return;
    }
    const kind = t.quick ? 'placeholder' : 'thumb';
    if (this.sent.get(photo.name) === 'thumb' && kind === 'placeholder') {
      return;
    }
    this.sink.send([{ name: photo.name, data: t.data, mime: 'image/webp', kind }]);
    this.sent.set(photo.name, kind);
  }

  dispose(): void {
    this.disposed = true;
    void this.service.compact(this.folder);
  }

  private send(name: string, t: Thumb): void {
    const kind = t.quick ? 'placeholder' : 'thumb';
    this.sink.send([{ name, data: t.data, mime: 'image/webp', kind }]);
    this.sent.set(name, kind);
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

        // 1. Cached thumbnails (sharp, or quick stand-ins) for what's on screen: local reads.
        const unsent = visible.filter((p) => this.sent.get(p.name) !== 'thumb');
        if (unsent.length) {
          const cached = await this.service.cached(this.folder, unsent);
          for (const [name, t] of cached) {
            if (!(t.quick && this.sent.get(name) === 'placeholder')) {
              this.send(name, t);
            }
            if (t.quick) {
              this.triedQuick.add(name);
            }
          }
        }

        // 2. Next task: a quick thumbnail for a visible photo with nothing yet, else a sharp one.
        const needsSharp = (p: Photo) => this.sent.get(p.name) !== 'thumb' && !this.failed.has(p.name) && !this.inflight.has(p.name);
        const quickFor = visible.find((p) => needsSharp(p) && !this.sent.has(p.name) && !this.triedQuick.has(p.name));
        const sharpFor = visible.find(needsSharp) ?? this.photos.find(needsSharp);
        if (!quickFor && !sharpFor) {
          break;
        }
        if (this.inflight.size >= 3) {
          break; // finishing tasks call pump() again
        }
        const p = (quickFor ?? sharpFor)!;
        const task = quickFor ? this.makeQuick(p) : this.makeSharp(p);
        this.inflight.add(p.name);
        void task.finally(() => {
          this.inflight.delete(p.name);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }

  private async makeQuick(p: Photo): Promise<void> {
    this.triedQuick.add(p.name);
    const t = await this.service.quick(p, this.service.fgHeads);
    if (t && !this.disposed && !this.sent.has(p.name)) {
      this.send(p.name, t);
    }
  }

  private async makeSharp(p: Photo): Promise<void> {
    if ((await this.service.state(p)) === 'sharp') {
      const t = (await this.service.cached(this.folder, [p])).get(p.name);
      if (t && !t.quick) {
        this.send(p.name, t);
        return;
      }
    }
    let t = await this.service.sharp(p, this.service.fgHeads, this.service.fgFulls);
    if (!t && !isJpeg(p.name) && !isRaw(p.name)) {
      t = await this.viaWebview(p); // PNG, WebP, GIF…: the browser decodes them
    }
    if (this.disposed) {
      return;
    }
    if (t) {
      this.send(p.name, t);
    } else {
      this.failed.add(p.name);
    }
  }

  private async viaWebview(p: Photo): Promise<Thumb | undefined> {
    const src = await this.service.source(p);
    if (!src || this.disposed) {
      return undefined;
    }
    const t = await this.sink.decode(p.name, src.data, src.mime, thumbPx()).catch(() => undefined);
    if (t) {
      await this.service.save(p, t);
      this.service.sources.webview++;
    }
    return t;
  }
}

function isJpeg(name: string): boolean {
  const e = extensionOf(name);
  return e === 'jpg' || e === 'jpeg' || e === 'jpe' || e === 'jfif';
}

/** The largest browser-decodable JPEG preview embedded in a RAW file. */
export async function rawPreview(fsPath: string): Promise<Uint8Array | undefined> {
  const head = await readHead(fsPath, RAW_HEAD_BYTES).catch(() => undefined);
  return head ? rawPreviewFrom(fsPath, head) : undefined;
}

async function rawPreviewFrom(fsPath: string, head: Uint8Array): Promise<Uint8Array | undefined> {
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
  switch (extensionOf(name)) {
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
