/**
 * Deciding what a photo *is* from its metadata alone: a screenshot, a picture from a camera, or
 * something else. No pixels are read and no `vscode` is imported, so this runs over thousands of
 * files in seconds and is easy to test.
 *
 * Only screenshots are decided here. Photographs of paper — receipts, whiteboards, book pages —
 * need the pixels, and `classifyByPixels` is where that will go (see the note at the bottom).
 */
import { ExifInfo } from './exif';
import { extensionOf } from './images';

/** The tags this module can write. A scan owns these names; a person can add any others. */
export const TAG_SCREENSHOT = 'Screenshot';
export const TAG_DOCUMENT = 'Document';

/** Everything the metadata rules look at. */
export interface Candidate {
  /** File name, with extension. */
  name: string;
  exif?: ExifInfo;
  /** Pixel size, when the listing knows it and the EXIF doesn't. */
  width?: number;
  height?: number;
}

export interface Verdict {
  /** Tags to write; empty when nothing was recognised. */
  tags: string[];
  /** 0–1. Above `CONFIDENT` the verdict is written; below it, nothing is. */
  confidence: number;
  /** Why, in a few words, for the log and the photo's details. */
  reason?: string;
}

/** A verdict at or above this is acted on. */
export const CONFIDENT = 0.6;

/**
 * Names the platforms give screenshots. Deliberately anchored at the start or after a separator:
 * a holiday photo called "screenshot-of-the-lake.jpg" is vanishingly rare, but "my-screen.jpg"
 * is not, so "screen" alone is never enough.
 */
const NAME_PATTERNS: RegExp[] = [
  /^screen[ _-]?shot\b/i, // macOS "Screen Shot 2019-…", "Screenshot 2024-…"
  /^screenshot[ _-]/i, // Android "Screenshot_20240101-…", Windows "Screenshot (3)"
  /^screenshot\.\w+$/i,
  /^screenshot \(\d+\)/i,
  /^simulator screen shot\b/i,
  /^captura de (?:pantalla|tela)\b/i, // es / pt-BR
  /^bildschirmfoto\b/i, // de
  /^capture d.?écran\b/i, // fr
];

/** Software tags that mean "this image was made by a screen, not a lens". */
const SOFTWARE_PATTERNS: RegExp[] = [/screenshot/i, /screen shot/i, /grab/i];

/**
 * Pixel sizes that mean "a screen", and that a photo is essentially never saved at.
 *
 * Deliberately short. Sizes a photo is commonly exported at were removed after they produced
 * false positives on a real library: 2048x1536 is an iPad screen *and* classic QXGA, 1920x1080
 * and 3840x2160 are everyday export sizes, and 4:3 and 16:9 are the two most common photo
 * aspects there are. What's left is tall phone screens (~19.5:9) and 16:10 laptop panels, which
 * photos don't use.
 */
const SCREEN_SIZES: [number, number][] = [
  // iPhone, 19.5:9 — a photo is never exactly these.
  [1125, 2436],
  [1170, 2532],
  [1179, 2556],
  [1284, 2778],
  [1290, 2796],
  [828, 1792],
  [1080, 2340],
  [1440, 3120],
  // MacBook panels, 16:10 and the taller notch sizes.
  [1440, 900],
  [1680, 1050],
  [1280, 800],
  [2880, 1800],
  [2560, 1600],
  [3024, 1964],
  [3456, 2234],
  [1366, 768],
];

const SCREENSHOT_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'heic']);

/** True when the size matches a known screen, in either orientation. */
export function isScreenSize(w?: number, h?: number): boolean {
  if (!w || !h) {
    return false;
  }
  return SCREEN_SIZES.some(([a, b]) => (w === a && h === b) || (w === b && h === a));
}

/**
 * True when the file carries none of the things a camera always records. A camera JPEG has a make
 * or a model, and an exposure; a screenshot has neither. Note this is also true of a photo
 * stripped of its EXIF by a messaging app, which is why it is never enough on its own.
 */
export function hasNoCameraSigns(exif?: ExifInfo): boolean {
  if (!exif) {
    return true;
  }
  return !exif.make && !exif.model && !exif.lens && !exif.exposureTime && !exif.fNumber && !exif.iso && !exif.focalLength;
}

/** What the metadata says about a file. See the rules in order of strength. */
export function classifyByMetadata(c: Candidate): Verdict {
  const ext = extensionOf(c.name);
  if (!SCREENSHOT_EXTS.has(ext)) {
    return { tags: [], confidence: 0 }; // a RAW file is never a screenshot
  }
  const exif = c.exif;
  const base = c.name.replace(/\.[^.]*$/, '');
  // The file header wins over EXIF. An edited photo can keep the dimensions it had before it was
  // cropped: a real case was a 1284x1253 baby photo whose EXIF still said 1284x2778, the screen
  // it was originally grabbed from, which matched a screen size and tagged it wrongly.
  const w = c.width ?? exif?.width;
  const h = c.height ?? exif?.height;

  // 1. It says so. Either the platform named the file, or the Software tag names a screen grabber.
  const namedFile = NAME_PATTERNS.some((re) => re.test(base));
  const namedSoftware = !!exif?.software && SOFTWARE_PATTERNS.some((re) => re.test(exif.software!));
  if (namedFile || namedSoftware) {
    return {
      tags: [TAG_SCREENSHOT],
      confidence: 0.98,
      reason: namedFile ? 'named like a screenshot' : `software: ${exif!.software}`,
    };
  }

  // 2. Nothing a camera records, in a format a screen grab is saved as. A PNG is already telling:
  // cameras don't write PNG. For the lossy formats the size has to agree as well, because a photo
  // that lost its EXIF on the way through a chat app looks the same otherwise.
  if (hasNoCameraSigns(exif)) {
    if (isScreenSize(w, h)) {
      return {
        tags: [TAG_SCREENSHOT],
        confidence: ext === 'png' ? 0.95 : 0.7,
        reason: 'no camera data, screen-sized',
      };
    }
    // Not enough to say. A PNG with no camera data looked like a safe bet, but a photo exported
    // or converted to PNG loses its EXIF on the way and lands here too — and on iOS a screenshot
    // and a photo are both IMG_nnnn.PNG, so the name doesn't separate them either. Deciding this
    // one needs the pixels (see classifyByPixels).
    return { tags: [], confidence: 0.3, reason: 'no camera data' };
  }

  // 3. It came from a camera.
  return { tags: [], confidence: 0 };
}

/**
 * Width and height from the first bytes of a PNG (its IHDR chunk is always first). PNGs carry no
 * EXIF, so this is the only way to check a screenshot's size against a known screen. Needs the
 * first 24 bytes; returns undefined for anything that isn't a PNG.
 */
export function pngSizeFrom(head: Uint8Array): { width: number; height: number } | undefined {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (head.length < 24 || !sig.every((b, i) => head[i] === b)) {
    return undefined;
  }
  // IHDR: 4-byte length, "IHDR", then width and height as big-endian 32-bit values.
  if (String.fromCharCode(head[12], head[13], head[14], head[15]) !== 'IHDR') {
    return undefined;
  }
  const be = (o: number) => ((head[o] << 24) | (head[o + 1] << 16) | (head[o + 2] << 8) | head[o + 3]) >>> 0;
  const width = be(16);
  const height = be(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * Width and height from a JPEG's SOF marker: the size the image really is, which EXIF may not
 * agree with after an edit. Returns undefined when no SOF is in the bytes given.
 */
export function jpegSizeFrom(head: Uint8Array): { width: number; height: number } | undefined {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) {
    return undefined;
  }
  let off = 2;
  while (off + 9 <= head.length) {
    if (head[off] !== 0xff) {
      return undefined; // not where a marker should be: give up rather than guess
    }
    const marker = head[off + 1];
    // Any SOFn carries the size, except DHT (c4), JPGA (c8) and DAC (cc), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (head[off + 5] << 8) | head[off + 6];
      const width = (head[off + 7] << 8) | head[off + 8];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (marker === 0xda) {
      return undefined; // image data: no SOF before it
    }
    off += 2 + ((head[off + 2] << 8) | head[off + 3]);
  }
  return undefined;
}

/**
 * Phase 2: photographs of paper, from the ~1024 px decode `analyzeJpeg` already produces — a
 * near-white background covering most of the frame, a bimodal histogram, dense thin dark strokes
 * in horizontal bands, and little colour. Not implemented yet; `scanTags` calls it only when it
 * returns something, so adding it needs no change anywhere else.
 */
export function classifyByPixels(): Verdict | undefined {
  return undefined;
}
