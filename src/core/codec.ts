/**
 * Thumbnail making in the extension host with WebAssembly codecs (jSquash: mozjpeg decoder,
 * libwebp encoder). Works the same on every OS, with no native modules. No `vscode` import.
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { Worker } from 'worker_threads';
import * as os from 'os';
import { downscale, orient, Rgba, trimBars } from './image';
import { Analysis, analyzePixels } from './analyze';

interface Decoder {
  init(module: WebAssembly.Module): Promise<unknown> | void;
  default(buf: ArrayBuffer, opts?: { preserveOrientation?: boolean }): Promise<Rgba>;
}
interface Encoder {
  init(module: WebAssembly.Module): Promise<unknown>;
  default(img: Rgba, opts?: { quality?: number; method?: number }): Promise<ArrayBuffer>;
}

// tsc would turn import() into require(), which cannot load these ES modules.
const importEsm = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>;

let loading: Promise<{ decode: Decoder; encode: Encoder }> | undefined;

function codecRoot(): string {
  // out/core/codec.js -> <extension>/node_modules/@jsquash
  return path.join(__dirname, '..', '..', 'node_modules', '@jsquash');
}

async function load(): Promise<{ decode: Decoder; encode: Encoder }> {
  // The decoder builds its result with `new ImageData`, which Node does not have.
  const g = globalThis as { ImageData?: unknown };
  g.ImageData ??= class ImageData {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  const root = codecRoot();
  const url = (p: string) => pathToFileURL(path.join(root, p)).href;
  const [decode, encode] = (await Promise.all([importEsm(url('jpeg/decode.js')), importEsm(url('webp/encode.js'))])) as [
    Decoder,
    Encoder,
  ];
  const wasm = async (p: string) => WebAssembly.compile(await fs.promises.readFile(path.join(root, p)));
  await decode.init(await wasm('jpeg/codec/dec/mozjpeg_dec.wasm'));
  let simd = true;
  try {
    await encode.init(await wasm('webp/codec/enc/webp_enc_simd.wasm'));
  } catch {
    simd = false;
  }
  if (!simd) {
    await encode.init(await wasm('webp/codec/enc/webp_enc.wasm'));
  }
  return { decode, encode };
}

export function codecs(): Promise<{ decode: Decoder; encode: Encoder }> {
  if (!loading) {
    loading = load();
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

export interface MadeThumb {
  data: Buffer;
  w: number;
  h: number;
  /** Size of the decoded source, before shrinking. */
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * JPEG bytes -> WebP thumbnail with long edge `px`. `orientation` is the photo's EXIF orientation
 * (previews and EXIF thumbnails are stored unrotated, like the main image). `trim` removes
 * letterbox bars (EXIF thumbnails).
 */
export interface ThumbOptions {
  px: number;
  orientation?: number;
  trim?: boolean;
  quality?: number;
}

/** In this thread. Used by the worker threads, and as a fallback when workers can't start. */
export async function makeThumbHere(jpeg: Uint8Array, opts: ThumbOptions): Promise<MadeThumb> {
  const { decode, encode } = await codecs();
  const ab = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
  // preserveOrientation=false: raw pixels as stored; we rotate ourselves after shrinking.
  let img = await decode.default(ab, { preserveOrientation: false });
  const sourceWidth = img.width;
  const sourceHeight = img.height;
  if (opts.trim) {
    img = trimBars(img);
  }
  img = orient(downscale(img, opts.px), opts.orientation);
  const webp = await encode.default(
    { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.byteLength), width: img.width, height: img.height },
    { quality: opts.quality ?? 60, method: 4 },
  );
  return { data: Buffer.from(webp), w: img.width, h: img.height, sourceWidth, sourceHeight };
}

export interface AnalyzeOptions {
  /** Also return the photo, upright, at this long edge (for the face model). */
  facePx?: number;
  orientation?: number;
}

export type Analyzed = Analysis & { sourceWidth: number; sourceHeight: number; pixels?: Rgba };

/** Decodes a JPEG and measures it for Auto-Rank at ~1024 px. In this thread. */
export async function analyzeHere(jpeg: Uint8Array, opts: AnalyzeOptions = {}): Promise<Analyzed> {
  const { decode } = await codecs();
  const ab = jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) as ArrayBuffer;
  const img = await decode.default(ab, { preserveOrientation: false });
  const a = analyzePixels(downscale(img, 1024));
  let pixels: Rgba | undefined;
  if (opts.facePx) {
    const p = orient(downscale(img, opts.facePx), opts.orientation);
    // Own copy: small, and transferable to another thread without dragging the full decode along.
    pixels = { data: new Uint8Array(p.data), width: p.width, height: p.height };
  }
  return { ...a, sourceWidth: img.width, sourceHeight: img.height, pixels };
}

// ---- worker pool ------------------------------------------------------------------------

/**
 * Decoding a JPEG takes tens of milliseconds of CPU. Done for a whole library on the extension
 * host's main thread it would make every extension sluggish, so it runs on worker threads.
 */
class Pool {
  private readonly workers: Array<{ w: Worker; busy: boolean }> = [];
  private readonly queue: Array<{ kind: 'thumb' | 'analyze'; jpeg: Uint8Array; opts?: ThumbOptions | AnalyzeOptions; resolve: (t: any) => void; reject: (e: unknown) => void }> = [];
  private readonly pending = new Map<number, { kind: 'thumb' | 'analyze'; resolve: (t: any) => void; reject: (e: unknown) => void; worker: { w: Worker; busy: boolean } }>();
  private nextId = 1;

  constructor(size: number) {
    const file = path.join(__dirname, 'codecWorker.js');
    for (let i = 0; i < size; i++) {
      const w = new Worker(file);
      const slot = { w, busy: false };
      w.on('message', (m: { id: number; ok: boolean; thumb?: MadeThumb & { data: Uint8Array }; analysis?: unknown; error?: string }) => {
        const job = this.pending.get(m.id);
        this.pending.delete(m.id);
        slot.busy = false;
        w.unref();
        if (job) {
          if (m.ok && m.analysis) {
            job.resolve(m.analysis);
          } else if (m.ok && m.thumb) {
            job.resolve({ ...m.thumb, data: Buffer.from(m.thumb.data.buffer, m.thumb.data.byteOffset, m.thumb.data.byteLength) });
          } else {
            job.reject(new Error(m.error ?? 'decode failed'));
          }
        }
        this.drain();
      });
      w.on('exit', () => {
        for (const [id, job] of this.pending) {
          if (job.worker === slot) {
            this.pending.delete(id);
            job.reject(new Error('codec worker exited'));
          }
        }
      });
      w.on('error', (err) => {
        slot.busy = false;
        w.unref();
        for (const [id, job] of this.pending) {
          if (job.worker === slot) {
            this.pending.delete(id);
            job.reject(err);
          }
        }
      });
      // Idle workers never keep the process alive; a busy one does (ref'd while it has a job).
      // Unref after the listeners: adding a 'message' listener refs the worker's port again.
      w.unref();
      this.workers.push(slot);
    }
  }

  run(jpeg: Uint8Array, opts: ThumbOptions): Promise<MadeThumb> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: 'thumb', jpeg, opts, resolve, reject });
      this.drain();
    });
  }

  analyze(jpeg: Uint8Array, opts: AnalyzeOptions): Promise<Analyzed> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: 'analyze', jpeg, opts, resolve, reject });
      this.drain();
    });
  }

  private drain(): void {
    for (const slot of this.workers) {
      if (slot.busy || !this.queue.length) {
        continue;
      }
      const job = this.queue.shift()!;
      const id = this.nextId++;
      slot.busy = true;
      slot.w.ref();
      this.pending.set(id, { kind: job.kind, resolve: job.resolve, reject: job.reject, worker: slot });
      // Copy into a fresh buffer we can hand over without copying again.
      const bytes = new Uint8Array(job.jpeg);
      slot.w.postMessage({ id, kind: job.kind, jpeg: bytes, opts: job.opts }, [bytes.buffer]);
    }
  }

  dispose(): void {
    for (const s of this.workers) {
      void s.w.terminate();
    }
  }
}

/**
 * Decoding threads: all but one core (the editor keeps one), between 2 and 6. Decoding a 24 MP
 * JPEG is the slow part when a photo has no built-in preview (e.g. Lightroom exports).
 */
export function codecThreads(): number {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(2, Math.min(6, cores - 1));
}

let pool: Pool | undefined;
let poolFailed = false;

/** JPEG bytes -> WebP thumbnail, on a worker thread when possible. */
export async function makeThumb(jpeg: Uint8Array, opts: ThumbOptions): Promise<MadeThumb> {
  if (!pool && !poolFailed && fs.existsSync(path.join(__dirname, 'codecWorker.js'))) {
    try {
      pool = new Pool(codecThreads());
    } catch {
      poolFailed = true;
    }
  }
  if (pool) {
    try {
      return await pool.run(jpeg, opts);
    } catch (err) {
      if (String(err).includes('decode failed') || String(err).includes('Decoding error')) {
        throw err; // a bad file, not a broken worker
      }
      poolFailed = true;
      pool.dispose();
      pool = undefined;
    }
  }
  return makeThumbHere(jpeg, opts);
}

/** Auto-Rank measurements of a JPEG, on a worker thread when possible. */
export async function analyzeJpeg(jpeg: Uint8Array, opts: AnalyzeOptions = {}): Promise<Analyzed> {
  if (!pool && !poolFailed && fs.existsSync(path.join(__dirname, 'codecWorker.js'))) {
    try {
      pool = new Pool(codecThreads());
    } catch {
      poolFailed = true;
    }
  }
  if (pool) {
    try {
      return await pool.analyze(jpeg, opts);
    } catch (err) {
      if (/decod/i.test(String(err))) {
        throw err;
      }
    }
  }
  return analyzeHere(jpeg, opts);
}

export function disposeCodecs(): void {
  pool?.dispose();
  pool = undefined;
}
