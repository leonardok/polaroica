/**
 * Export one photo to a JPEG: decode (JPEG, or RAW with LibRaw at full size), apply the photo
 * tab's adjustments, resize, encode with mozjpeg, and write with EXIF, a thumbnail and an MPF
 * preview. Runs on worker threads (exportWorker.ts); also callable here for tests.
 * No `vscode` import.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import { asShotKelvin } from './whiteBalance';
import { applyEdits, matchToPreview, rgbToRgba } from './develop';
import { embeddedPreviews, readExif } from './exif';
import { downscale, orient, Rgba } from './image';
import { isRaw } from './images';
import { assembleJpeg, buildExif } from './jpegFile';
import { Edits } from './xmp';

export interface ExportOptions {
  /** Long edge in pixels; undefined = full size. */
  maxSide?: number;
  /** JPEG quality 1–100. */
  quality: number;
  /** The photo tab's adjustments to bake in. */
  edits?: Edits;
}

export interface ExportResult {
  width: number;
  height: number;
  bytes: number;
  /** How the image was made: 'jpeg', 'raw' (LibRaw, matched to the camera preview), 'raw-plain'. */
  source: 'jpeg' | 'raw' | 'raw-plain';
}

const THUMB_PX = 160;
const PREVIEW_PX = 1600;

interface JpegDecoder {
  init(module: WebAssembly.Module): Promise<unknown> | void;
  default(buf: ArrayBuffer, opts?: { preserveOrientation?: boolean }): Promise<Rgba>;
}
interface JpegEncoder {
  init(module: WebAssembly.Module): Promise<unknown>;
  default(img: Rgba, opts?: { quality?: number }): Promise<ArrayBuffer>;
}
interface LibRawModule {
  LibRaw: new () => {
    open(buf: Uint8Array, settings: Record<string, unknown>): unknown;
    imageData(): { width: number; height: number; colors: number; bits: number; data: Uint8Array | Uint16Array };
    metadata(full?: boolean): { color_data?: { cam_mul?: number[]; cam_xyz?: number[][] } } | undefined;
    delete?(): void;
  };
}

// tsc would turn import() into require(), which cannot load these ES modules.
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

function modulesRoot(): string {
  // out/core/exporter.js -> <extension>/node_modules
  return path.join(__dirname, '..', '..', 'node_modules');
}

let jpegCodecs: Promise<{ decode: JpegDecoder; encode: JpegEncoder }> | undefined;
function jpeg(): Promise<{ decode: JpegDecoder; encode: JpegEncoder }> {
  jpegCodecs ??= (async () => {
    const g = globalThis as { ImageData?: unknown };
    g.ImageData ??= class ImageData {
      constructor(
        readonly data: Uint8ClampedArray,
        readonly width: number,
        readonly height: number,
      ) {}
    };
    const root = path.join(modulesRoot(), '@jsquash', 'jpeg');
    const [decode, encode] = (await Promise.all([
      importEsm(pathToFileURL(path.join(root, 'decode.js')).href),
      importEsm(pathToFileURL(path.join(root, 'encode.js')).href),
    ])) as [JpegDecoder, JpegEncoder];
    const wasm = async (p: string) => WebAssembly.compile(await fs.promises.readFile(path.join(root, 'codec', p)));
    await decode.init(await wasm('dec/mozjpeg_dec.wasm'));
    await encode.init(await wasm('enc/mozjpeg_enc.wasm'));
    return { decode, encode };
  })();
  jpegCodecs.catch(() => (jpegCodecs = undefined));
  return jpegCodecs;
}

let libraw: Promise<LibRawModule> | undefined;
function libRaw(): Promise<LibRawModule> {
  libraw ??= (async () => {
    const dist = path.join(modulesRoot(), 'libraw-wasm', 'dist');
    const factory = ((await importEsm(pathToFileURL(path.join(dist, 'libraw.js')).href)) as { default: (o: object) => Promise<LibRawModule> })
      .default;
    return factory({ wasmBinary: await fs.promises.readFile(path.join(dist, 'libraw.wasm')) });
  })();
  libraw.catch(() => (libraw = undefined));
  return libraw;
}

const toArrayBuffer = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The camera's own preview in a RAW file (largest that decodes), for its colours and tones. */
async function rawReference(file: Uint8Array): Promise<Rgba | undefined> {
  const { decode } = await jpeg();
  for (const r of embeddedPreviews(file.subarray(0, 256 * 1024))) {
    if (r.length < 32 * 1024 || r.offset + r.length > file.length) continue; // skip tiny thumbnails
    const bytes = file.subarray(r.offset, r.offset + r.length);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) continue;
    try {
      return await decode.default(toArrayBuffer(bytes), { preserveOrientation: false });
    } catch {
      /* not a baseline JPEG (lossless RAW data): try the next */
    }
  }
  return undefined;
}

/**
 * A RAW file's as-shot white balance in Kelvin. LibRaw only parses the header here (no decoding);
 * the first 256 KB hold the white-balance tags in the files tried (Sony ARW, Nikon NEF).
 */
export async function rawAsShotKelvin(fsPath: string): Promise<number | undefined> {
  const fh = await fs.promises.open(fsPath, 'r');
  let head: Uint8Array;
  try {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  } finally {
    await fh.close();
  }
  const M = await libRaw();
  const lr = new M.LibRaw();
  try {
    lr.open(head, {});
    return asShotKelvin(lr.metadata(true)?.color_data);
  } catch {
    return undefined;
  } finally {
    lr.delete?.();
  }
}

/** Full-size pixels of a RAW file, upright. */
async function decodeRaw(file: Uint8Array): Promise<{ img: Rgba; matched: boolean }> {
  const M = await libRaw();
  const ref = await rawReference(file);
  const lr = new M.LibRaw();
  try {
    if (ref) {
      lr.open(file, { useCameraWb: true, outputBps: 16, userQual: 3, noAutoBright: true });
      const d = lr.imageData();
      return { img: matchToPreview({ data: d.data as Uint16Array, width: d.width, height: d.height }, ref), matched: true };
    }
    lr.open(file, { useCameraWb: true, outputBps: 8, userQual: 3 });
    const d = lr.imageData();
    return { img: rgbToRgba(d.data as Uint8Array, d.width, d.height), matched: false };
  } finally {
    lr.delete?.();
  }
}

/** Decodes, develops and encodes `src`; returns the finished JPEG file's bytes. */
export async function renderExport(src: string, opts: ExportOptions): Promise<{ jpeg: Uint8Array } & Omit<ExportResult, 'bytes'>> {
  const file = new Uint8Array(await fs.promises.readFile(src));
  const info = readExif(file.subarray(0, 256 * 1024));
  const { decode, encode } = await jpeg();
  let img: Rgba;
  let source: ExportResult['source'];
  if (isRaw(path.basename(src))) {
    const r = await decodeRaw(file);
    img = r.img;
    source = r.matched ? 'raw' : 'raw-plain';
  } else if (file[0] === 0xff && file[1] === 0xd8) {
    img = orient(await decode.default(toArrayBuffer(file), { preserveOrientation: false }), info?.orientation);
    source = 'jpeg';
  } else {
    throw new Error('only JPEG and RAW photos can be exported');
  }
  if (opts.edits) {
    applyEdits(img, opts.edits);
  }
  if (opts.maxSide && Math.max(img.width, img.height) > opts.maxSide) {
    img = downscale(img, opts.maxSide);
  }
  // Baseline with optimized Huffman tables: ~40% faster than mozjpeg's progressive default, ~3%
  // bigger, and quicker to open in most viewers.
  const enc = async (im: Rgba, quality: number) =>
    new Uint8Array(await encode.default(im, { quality, baseline: true, progressive: false, optimize_coding: true } as { quality: number }));
  const main = await enc(img, opts.quality);
  const thumb = await enc(downscale(img, THUMB_PX), 75);
  const big = Math.max(img.width, img.height) > PREVIEW_PX * 1.25;
  const preview = big ? await enc(downscale(img, PREVIEW_PX), 80) : undefined;
  const exif = buildExif(info, img.width, img.height, thumb);
  return { jpeg: assembleJpeg(main, exif, preview), width: img.width, height: img.height, source };
}

/** Renders and writes `dest` (through a temporary file, so a failure never leaves half a JPEG). */
export async function exportHere(src: string, dest: string, opts: ExportOptions): Promise<ExportResult> {
  const r = await renderExport(src, opts);
  const tmp = `${dest}.partial`;
  try {
    await fs.promises.writeFile(tmp, r.jpeg);
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return { width: r.width, height: r.height, bytes: r.jpeg.length, source: r.source };
}

/**
 * Worker threads for exports. RAW decoding needs ~700 MB per thread, so few threads; they are
 * ended when the export finishes (WebAssembly memory is only returned that way).
 */
export class ExportPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<number, { resolve: (r: ExportResult) => void; reject: (e: Error) => void }>();
  private nextId = 0;
  private readonly idle: Worker[] = [];
  private readonly queue: Array<{ id: number; msg: object }> = [];

  constructor(private readonly size: number) {}

  run(src: string, dest: string, opts: ExportOptions): Promise<ExportResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.queue.push({ id, msg: { id, src, dest, opts } });
      this.drain();
    });
  }

  private spawn(): Worker {
    const w = new Worker(path.join(__dirname, 'exportWorker.js'));
    w.on('message', (m: { id: number; ok: boolean; result?: ExportResult; error?: string }) => {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.ok && m.result) p?.resolve(m.result);
      else p?.reject(new Error(m.error ?? 'export failed'));
      this.idle.push(w);
      this.drain();
    });
    const fail = (err: Error) => {
      // A crashed worker (out of memory): fail its job, replace it on the next run.
      const i = this.workers.indexOf(w);
      if (i >= 0) this.workers.splice(i, 1);
      const j = this.idle.indexOf(w);
      if (j >= 0) this.idle.splice(j, 1);
      const job = (w as Worker & { job?: number }).job;
      if (job !== undefined) {
        this.pending.get(job)?.reject(err);
        this.pending.delete(job);
      }
      this.drain();
    };
    w.on('error', fail);
    w.on('exit', (code) => code !== 0 && fail(new Error(`export worker stopped (code ${code}); the photo may be too large`)));
    this.workers.push(w);
    return w;
  }

  private drain(): void {
    while (this.queue.length) {
      let w = this.idle.pop();
      if (!w && this.workers.length < this.size) w = this.spawn();
      if (!w) return;
      const job = this.queue.shift()!;
      (w as Worker & { job?: number }).job = job.id;
      w.postMessage(job.msg);
    }
  }

  dispose(): void {
    for (const w of this.workers) void w.terminate();
    this.workers.length = 0;
    this.idle.length = 0;
    for (const p of this.pending.values()) p.reject(new Error('export cancelled'));
    this.pending.clear();
  }
}
