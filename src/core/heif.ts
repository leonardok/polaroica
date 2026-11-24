/**
 * HEIC/HEIF decoding in the extension host, with libheif compiled to WebAssembly (libheif-js).
 * Same on every OS, no native modules — like the jSquash codecs in `codec.ts`.
 *
 * libheif is LGPL-3.0 and bundles an HEVC decoder; see THIRD-PARTY-NOTICES.md. Nothing here
 * encodes HEIF: the decoded pixels are re-encoded as WebP by `codec.ts`.
 *
 * No `vscode` import.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Rgba } from './image';

/** One image item of a HEIF file, as libheif-js hands it over. */
interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void): void;
  free?(): void;
}

interface HeifModule {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
}

/** Largest HEIF we will decode: a 48 MP image is ~190 MB of RGBA, already more than we want. */
export const MAX_HEIF_PIXELS = 80e6;

let loading: Promise<HeifModule> | undefined;

function heifRoot(): string {
  // out/core/heif.js -> <extension>/node_modules/libheif-js
  return path.join(__dirname, '..', '..', 'node_modules', 'libheif-js');
}

/**
 * The wasm build, loaded by hand: libheif-js's own `wasm.js` entry point reads the .wasm with a
 * path relative to the working directory, which is never ours.
 */
async function load(): Promise<HeifModule> {
  const root = heifRoot();
  const factory = require(path.join(root, 'libheif-wasm', 'libheif.js')) as (opts: { wasmBinary: Uint8Array }) => HeifModule;
  const wasmBinary = await fs.promises.readFile(path.join(root, 'libheif-wasm', 'libheif.wasm'));
  return factory({ wasmBinary });
}

export function heif(): Promise<HeifModule> {
  if (!loading) {
    loading = load();
    loading.catch(() => {
      loading = undefined;
    });
  }
  return loading;
}

/**
 * HEIF bytes -> RGBA pixels of the primary image. libheif applies the file's own rotation and
 * mirroring (`irot`/`imir`), so the result is already upright and needs no EXIF orientation.
 */
export async function decodeHeif(bytes: Uint8Array): Promise<Rgba> {
  const { HeifDecoder } = await heif();
  const images = new HeifDecoder().decode(bytes);
  const image = images[0];
  if (!image) {
    throw new Error('HEIF decode failed: no image in the file');
  }
  try {
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0)) {
      throw new Error('HEIF decode failed: empty image');
    }
    if (width * height > MAX_HEIF_PIXELS) {
      throw new Error(`HEIF decode failed: ${width}×${height} is too large`);
    }
    const out = await new Promise<{ data: Uint8ClampedArray; width: number; height: number }>((resolve, reject) => {
      const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
      image.display(target, (result) => (result ? resolve(result) : reject(new Error('HEIF decode failed'))));
    });
    return { data: out.data, width: out.width, height: out.height };
  } finally {
    for (const i of images) {
      i.free?.();
    }
  }
}
