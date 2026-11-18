/**
 * Writes export JPEGs that are quick to browse: EXIF (camera, lens, exposure, date) with a small
 * thumbnail in IFD1, and an MPF (Multi-Picture Format) preview of ~1600 px after the main image,
 * the same structure cameras use. Viewers (this extension included) show the thumbnail and
 * preview without decoding the full image. No `vscode` import.
 */
import { ExifInfo } from './exif';

type Entry = { tag: number; type: 2 | 3 | 4 | 5 | 7; value: string | number | number[] | Uint8Array };

const TYPE_SIZE = { 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 } as const;

/** Bytes of a value (big-endian), before deciding inline vs. offset. */
function valueBytes(e: Entry): Uint8Array {
  switch (e.type) {
    case 2: {
      const s = String(e.value);
      const b = new Uint8Array(s.length + 1);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0x7f;
      return b;
    }
    case 7:
      return e.value instanceof Uint8Array ? e.value : new Uint8Array(0);
    case 3: {
      const vs = Array.isArray(e.value) ? e.value : [Number(e.value)];
      const b = new Uint8Array(vs.length * 2);
      const v = new DataView(b.buffer);
      vs.forEach((x, i) => v.setUint16(i * 2, x));
      return b;
    }
    case 4: {
      const vs = Array.isArray(e.value) ? e.value : [Number(e.value)];
      const b = new Uint8Array(vs.length * 4);
      const v = new DataView(b.buffer);
      vs.forEach((x, i) => v.setUint32(i * 4, x >>> 0));
      return b;
    }
    case 5: {
      const [num, den] = e.value as number[];
      const b = new Uint8Array(8);
      const v = new DataView(b.buffer);
      v.setUint32(0, num >>> 0);
      v.setUint32(4, den >>> 0);
      return b;
    }
  }
}

function countOf(e: Entry, bytes: Uint8Array): number {
  return e.type === 5 ? 1 : bytes.length / TYPE_SIZE[e.type];
}

/** Size of an IFD with its out-of-line values. */
function ifdSize(entries: Entry[]): number {
  let size = 2 + entries.length * 12 + 4;
  for (const e of entries) {
    const n = valueBytes(e).length;
    if (n > 4) size += n + (n & 1);
  }
  return size;
}

/** Writes an IFD at `at` (offset from the TIFF header), values right after it. */
function writeIfd(out: Uint8Array, at: number, entries: Entry[], next: number): void {
  const v = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  v.setUint16(at, sorted.length);
  let data = at + 2 + sorted.length * 12 + 4;
  sorted.forEach((e, i) => {
    const p = at + 2 + i * 12;
    const bytes = valueBytes(e);
    v.setUint16(p, e.tag);
    v.setUint16(p + 2, e.type);
    v.setUint32(p + 4, countOf(e, bytes));
    if (bytes.length <= 4) {
      out.set(bytes, p + 8);
    } else {
      v.setUint32(p + 8, data);
      out.set(bytes, data);
      data += bytes.length + (bytes.length & 1);
    }
  });
  v.setUint32(at + 2 + sorted.length * 12, next);
}

/** A number as an EXIF rational: exposure times as 1/x, others to 1/1000. */
export function rational(x: number): [number, number] {
  if (x > 0 && x < 1 && Math.abs(1 / x - Math.round(1 / x)) < 1e-3) {
    return [1, Math.round(1 / x)];
  }
  let num = Math.round(x * 1000);
  let den = 1000;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const g = gcd(Math.abs(num), den) || 1;
  num /= g;
  den /= g;
  return [num, den];
}

/** The TIFF structure of an APP1 "Exif" segment (without the "Exif\0\0" prefix). */
export function buildExif(info: ExifInfo | undefined, width: number, height: number, thumb?: Uint8Array, orientation = 1): Uint8Array {
  const i = info ?? {};
  const res = (tag: number): Entry => ({ tag, type: 5, value: [72, 1] });
  const ifd0: Entry[] = [
    { tag: 0x0112, type: 3, value: orientation }, // exports: 1, the pixels are upright
    res(0x011a),
    res(0x011b),
    { tag: 0x0128, type: 3, value: 2 },
    { tag: 0x0131, type: 2, value: 'Polaroica for VS Code' },
    { tag: 0x8769, type: 4, value: 0 }, // Exif IFD, filled below
  ];
  if (i.make) ifd0.push({ tag: 0x010f, type: 2, value: i.make });
  if (i.model) ifd0.push({ tag: 0x0110, type: 2, value: i.model });
  if (i.dateTaken) ifd0.push({ tag: 0x0132, type: 2, value: i.dateTaken });

  const exif: Entry[] = [
    { tag: 0x9000, type: 7, value: new Uint8Array([0x30, 0x32, 0x33, 0x32]) }, // "0232"
    { tag: 0xa001, type: 3, value: 1 }, // sRGB
    { tag: 0xa002, type: 4, value: width },
    { tag: 0xa003, type: 4, value: height },
  ];
  if (i.exposureTime) exif.push({ tag: 0x829a, type: 5, value: rational(i.exposureTime) });
  if (i.fNumber) exif.push({ tag: 0x829d, type: 5, value: rational(i.fNumber) });
  if (i.iso) exif.push({ tag: 0x8827, type: 3, value: Math.min(65535, Math.round(i.iso)) });
  if (i.dateTaken) exif.push({ tag: 0x9003, type: 2, value: i.dateTaken });
  if (i.subSec) exif.push({ tag: 0x9291, type: 2, value: i.subSec });
  if (i.focalLength) exif.push({ tag: 0x920a, type: 5, value: rational(i.focalLength) });
  if (i.lens) exif.push({ tag: 0xa434, type: 2, value: i.lens });

  const ifd1: Entry[] | undefined = thumb
    ? [
        { tag: 0x0103, type: 3, value: 6 }, // JPEG thumbnail
        res(0x011a),
        res(0x011b),
        { tag: 0x0128, type: 3, value: 2 },
        { tag: 0x0201, type: 4, value: 0 }, // offset, filled below
        { tag: 0x0202, type: 4, value: thumb.length },
      ]
    : undefined;

  const at0 = 8;
  const atExif = at0 + ifdSize(ifd0);
  const at1 = atExif + ifdSize(exif);
  const atThumb = ifd1 ? at1 + ifdSize(ifd1) : at1;
  const total = atThumb + (thumb?.length ?? 0);
  ifd0.find((e) => e.tag === 0x8769)!.value = atExif;
  if (ifd1) ifd1.find((e) => e.tag === 0x0201)!.value = atThumb;

  const out = new Uint8Array(total);
  out.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8]); // big-endian TIFF, IFD0 at 8
  writeIfd(out, at0, ifd0, ifd1 ? at1 : 0);
  writeIfd(out, atExif, exif, 0);
  if (ifd1 && thumb) {
    writeIfd(out, at1, ifd1, 0);
    out.set(thumb, atThumb);
  }
  return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  if (payload.length + 2 > 0xffff) {
    throw new Error('JPEG segment too large');
  }
  const out = new Uint8Array(4 + payload.length);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (payload.length + 2) >> 8;
  out[3] = (payload.length + 2) & 0xff;
  out.set(payload, 4);
  return out;
}

/** The encoder's JPEG after SOI, without APP0/APP1 (JFIF, old EXIF): we write our own. */
function bodyAfterHeaders(jpeg: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
    throw new Error('not a JPEG');
  }
  let off = 2;
  while (off + 4 <= jpeg.length && jpeg[off] === 0xff && (jpeg[off + 1] === 0xe0 || jpeg[off + 1] === 0xe1)) {
    off += 2 + ((jpeg[off + 2] << 8) | jpeg[off + 3]);
  }
  return jpeg.subarray(off);
}

const MPF_IFD_ENTRIES = 3;
/** "MPF\0" + TIFF header + index IFD (3 entries) + 2 MP entries. */
const MPF_PAYLOAD = 4 + 8 + (2 + MPF_IFD_ENTRIES * 12 + 4) + 2 * 16;

/**
 * One JPEG file: `main` (an encoder's output) with our EXIF (and its thumbnail), and when given,
 * `preview` stored after the main image and indexed by an MPF segment.
 */
export function assembleJpeg(main: Uint8Array, exif: Uint8Array, preview?: Uint8Array): Uint8Array {
  const soi = new Uint8Array([0xff, 0xd8]);
  const app1Payload = new Uint8Array(6 + exif.length);
  app1Payload.set([0x45, 0x78, 0x69, 0x66, 0, 0]); // "Exif\0\0"
  app1Payload.set(exif, 6);
  const app1 = segment(0xe1, app1Payload);
  const body = bodyAfterHeaders(main);
  if (!preview) {
    return concat([soi, app1, body]);
  }
  const mpfAt = soi.length + app1.length; // the APP2 marker
  const tiffAt = mpfAt + 4 + 4; // after FF E2, length, "MPF\0"
  const primarySize = soi.length + app1.length + 4 + MPF_PAYLOAD + body.length;
  const payload = new Uint8Array(MPF_PAYLOAD);
  const v = new DataView(payload.buffer);
  payload.set([0x4d, 0x50, 0x46, 0x00]); // "MPF\0"
  const t = 4; // TIFF header inside the payload
  payload.set([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8], t);
  const ifd = t + 8;
  v.setUint16(ifd, MPF_IFD_ENTRIES);
  const entry = (k: number, tag: number, type: number, count: number) => {
    const p = ifd + 2 + k * 12;
    v.setUint16(p, tag);
    v.setUint16(p + 2, type);
    v.setUint32(p + 4, count);
    return p + 8;
  };
  payload.set([0x30, 0x31, 0x30, 0x30], entry(0, 0xb000, 7, 4)); // MPF version "0100"
  v.setUint32(entry(1, 0xb001, 4, 1), 2); // number of images
  const entriesRel = 8 + 2 + MPF_IFD_ENTRIES * 12 + 4; // from the TIFF header
  v.setUint32(entry(2, 0xb002, 7, 32), entriesRel);
  v.setUint32(ifd + 2 + MPF_IFD_ENTRIES * 12, 0); // no next IFD
  const e0 = t + entriesRel;
  v.setUint32(e0, 0x20030000); // representative, baseline primary image
  v.setUint32(e0 + 4, primarySize);
  v.setUint32(e0 + 8, 0);
  v.setUint32(e0 + 16, 0x00010002); // large thumbnail (full-HD class)
  v.setUint32(e0 + 20, preview.length);
  v.setUint32(e0 + 24, primarySize - tiffAt);
  return concat([soi, app1, segment(0xe2, payload), body, preview]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
