/**
 * Minimal EXIF / TIFF reader. Reads the TIFF structure found in JPEG APP1 segments and in
 * TIFF-based RAW files (NEF, CR2, ARW, DNG, ORF, RW2, PEF, ...) for:
 *  - the handful of tags the details panel shows,
 *  - the small thumbnail JPEG cameras embed in EXIF (instant placeholder),
 *  - the large preview JPEGs RAW files embed (RAW display without a RAW decoder).
 * No `vscode` import.
 */

export interface ExifInfo {
  make?: string;
  model?: string;
  lens?: string;
  dateTaken?: string; // "YYYY:MM:DD HH:MM:SS" as stored
  exposureTime?: number; // seconds
  fNumber?: number;
  iso?: number;
  focalLength?: number; // mm
  width?: number;
  height?: number;
  orientation?: number;
}

/** A byte range inside the file (or the buffer that was parsed). */
export interface ByteRange {
  offset: number;
  length: number;
}

const TAG = {
  imageWidth: 0x0100,
  imageHeight: 0x0101,
  compression: 0x0103,
  make: 0x010f,
  model: 0x0110,
  stripOffsets: 0x0111,
  orientation: 0x0112,
  stripByteCounts: 0x0117,
  subIfds: 0x014a,
  jpegOffset: 0x0201,
  jpegLength: 0x0202,
  exifIfd: 0x8769,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  focalLength: 0x920a,
  pixelX: 0xa002,
  pixelY: 0xa003,
  lensModel: 0xa434,
};

type Value = number | string | number[] | undefined;

interface Ifd {
  /** Tag -> value. Arrays for multi-value numeric tags. */
  tags: Map<number, Value>;
  /** 0 = IFD0, 1 = IFD1 (thumbnail), 'exif', 'sub' */
  kind: string;
}

/** Walks every IFD reachable from a TIFF header at `base` inside `buf`. */
function readTiff(buf: Uint8Array, base: number, end: number): Ifd[] | undefined {
  if (end - base < 8) {
    return undefined;
  }
  const little = buf[base] === 0x49;
  if (!little && buf[base] !== 0x4d) {
    return undefined;
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const inRange = (o: number, n: number) => o >= base && o + n <= end;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 13: 4 };

  const readValue = (entry: number): Value => {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = (typeSize[type] ?? 0) * count;
    if (!size || count > 100000) {
      return undefined;
    }
    const valOff = size <= 4 ? entry + 8 : base + u32(entry + 8);
    if (!inRange(valOff, size)) {
      return undefined;
    }
    switch (type) {
      case 2: {
        let s = '';
        for (let i = 0; i < count; i++) {
          const c = buf[valOff + i];
          if (c === 0) {
            break;
          }
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 3:
      case 4:
      case 13: {
        const one = (i: number) => (type === 3 ? u16(valOff + i * 2) : u32(valOff + i * 4));
        if (count === 1) {
          return one(0);
        }
        return Array.from({ length: Math.min(count, 64) }, (_, i) => one(i));
      }
      case 9:
        return view.getInt32(valOff, little);
      case 5: {
        const d = u32(valOff + 4);
        return d ? u32(valOff) / d : undefined;
      }
      case 10: {
        const d = view.getInt32(valOff + 4, little);
        return d ? view.getInt32(valOff, little) / d : undefined;
      }
      default:
        return undefined;
    }
  };

  const out: Ifd[] = [];
  const seen = new Set<number>();
  const visit = (rel: number, kind: string, depth: number, followNext: boolean) => {
    let ifd = base + rel;
    let n = 0;
    while (rel && depth < 4 && !seen.has(ifd) && inRange(ifd, 2) && n++ < 8) {
      seen.add(ifd);
      const count = u16(ifd);
      if (count > 1000 || !inRange(ifd + 2, count * 12)) {
        return;
      }
      const tags = new Map<number, Value>();
      for (let i = 0; i < count; i++) {
        const e = ifd + 2 + i * 12;
        tags.set(u16(e), readValue(e));
      }
      const thisKind = kind === 'ifd' ? String(out.filter((x) => /^\d+$/.test(x.kind)).length) : kind;
      out.push({ tags, kind: thisKind });
      const exif = tags.get(TAG.exifIfd);
      if (typeof exif === 'number') {
        visit(exif, 'exif', depth + 1, false);
      }
      const subs = tags.get(TAG.subIfds);
      for (const s of Array.isArray(subs) ? subs : typeof subs === 'number' ? [subs] : []) {
        visit(s, 'sub', depth + 1, false);
      }
      if (!followNext || !inRange(ifd + 2 + count * 12, 4)) {
        return;
      }
      rel = u32(ifd + 2 + count * 12);
      ifd = base + rel;
    }
  };
  visit(u32(base + 4), 'ifd', 0, true);
  return out;
}

/** Where the TIFF structure starts: inside the JPEG APP1 "Exif" segment, or at 0 for TIFF/RAW. */
function tiffBase(buf: Uint8Array): { base: number; end: number } | undefined {
  if (buf.length < 8) {
    return undefined;
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let off = 2;
    while (off + 4 <= buf.length) {
      if (buf[off] !== 0xff) {
        return undefined;
      }
      const marker = buf[off + 1];
      if (marker === 0xd9 || marker === 0xda) {
        return undefined; // end of image / start of scan: no EXIF before pixels
      }
      const len = (buf[off + 2] << 8) | buf[off + 3];
      if (
        marker === 0xe1 &&
        off + 10 <= buf.length &&
        buf[off + 4] === 0x45 &&
        buf[off + 5] === 0x78 &&
        buf[off + 6] === 0x69 &&
        buf[off + 7] === 0x66
      ) {
        return { base: off + 10, end: Math.min(buf.length, off + 2 + len) };
      }
      off += 2 + len;
    }
    return undefined;
  }
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    return { base: 0, end: buf.length };
  }
  return undefined;
}

/** Parse EXIF from the first bytes of a file (64–256 KB is plenty for JPEG and most RAW). */
export function readExif(buf: Uint8Array): ExifInfo | undefined {
  const at = tiffBase(buf);
  const ifds = at && readTiff(buf, at.base, at.end);
  if (!ifds) {
    return undefined;
  }
  const info: ExifInfo = {};
  const str = (v: Value) => (typeof v === 'string' && v ? v : undefined);
  const num = (v: Value) => (typeof v === 'number' ? v : undefined);
  for (const ifd of ifds) {
    const t = ifd.tags;
    const main = ifd.kind === '0' || ifd.kind === 'exif';
    if (!main) {
      continue;
    }
    info.make ??= str(t.get(TAG.make));
    info.model ??= str(t.get(TAG.model));
    info.lens ??= str(t.get(TAG.lensModel));
    info.dateTaken ??= str(t.get(TAG.dateTimeOriginal));
    info.exposureTime ??= num(t.get(TAG.exposureTime));
    info.fNumber ??= num(t.get(TAG.fNumber));
    info.iso ??= num(t.get(TAG.iso));
    info.focalLength ??= num(t.get(TAG.focalLength));
    info.orientation ??= num(t.get(TAG.orientation));
    if (ifd.kind === 'exif') {
      info.width = num(t.get(TAG.pixelX)) ?? info.width;
      info.height = num(t.get(TAG.pixelY)) ?? info.height;
    } else {
      info.width ??= num(t.get(TAG.imageWidth));
      info.height ??= num(t.get(TAG.imageHeight));
    }
  }
  for (const k of Object.keys(info) as (keyof ExifInfo)[]) {
    if (info[k] === undefined) {
      delete info[k];
    }
  }
  return Object.keys(info).length ? info : undefined;
}

/**
 * The small thumbnail JPEG in a JPEG's EXIF (IFD1), as a range inside `buf`. Typically
 * 160×120. Returns undefined when absent or not fully inside `buf`.
 */
export function embeddedThumbnail(buf: Uint8Array): ByteRange | undefined {
  const at = tiffBase(buf);
  if (!at || at.base === 0) {
    return undefined; // only for JPEG; RAW files use embeddedPreviews()
  }
  const ifds = readTiff(buf, at.base, at.end);
  const ifd1 = ifds?.find((i) => i.kind === '1');
  const off = ifd1?.tags.get(TAG.jpegOffset);
  const len = ifd1?.tags.get(TAG.jpegLength);
  if (typeof off !== 'number' || typeof len !== 'number' || !len) {
    return undefined;
  }
  const offset = at.base + off;
  if (offset + len > buf.length || buf[offset] !== 0xff || buf[offset + 1] !== 0xd8) {
    return undefined;
  }
  return { offset, length: len };
}

/**
 * Preview JPEGs embedded in a RAW file, largest first, as absolute file offsets. Parse the
 * file's first bytes (256 KB); the previews themselves are usually further in and are read
 * separately. Covers TIFF-based RAW (NEF, CR2, ARW, DNG, ORF, RW2, PEF, ...) and Fujifilm RAF.
 */
export function embeddedPreviews(head: Uint8Array): ByteRange[] {
  // Fujifilm RAF: big-endian JPEG offset/length at bytes 84 and 88.
  if (head.length >= 92 && String.fromCharCode(...head.subarray(0, 15)) === 'FUJIFILMCCD-RAW') {
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const offset = v.getUint32(84, false);
    const length = v.getUint32(88, false);
    return length ? [{ offset, length }] : [];
  }
  const at = tiffBase(head);
  if (!at || at.base !== 0) {
    return [];
  }
  // Offsets may point past `head`: parse with an "end" far beyond so IFD values resolve when
  // inside head, and only collect offset/length numbers (validated when the bytes are read).
  const ifds = readTiff(head, 0, head.length) ?? [];
  const found: ByteRange[] = [];
  for (const ifd of ifds) {
    const t = ifd.tags;
    const off = t.get(TAG.jpegOffset);
    const len = t.get(TAG.jpegLength);
    if (typeof off === 'number' && typeof len === 'number' && len > 0) {
      found.push({ offset: off, length: len });
    }
    const comp = t.get(TAG.compression);
    const so = t.get(TAG.stripOffsets);
    const sc = t.get(TAG.stripByteCounts);
    // Compression 6 (old JPEG) / 7 (JPEG) stored as a single strip: a JPEG preview. Skip
    // DNG/NEF main images that are lossless JPEG (those start with SOF3, filtered on read).
    if ((comp === 6 || comp === 7) && typeof so === 'number' && typeof sc === 'number' && sc > 0) {
      found.push({ offset: so, length: sc });
    }
  }
  const unique = new Map(found.map((r) => [`${r.offset}:${r.length}`, r]));
  return [...unique.values()].sort((a, b) => b.length - a.length);
}

/**
 * Preview images stored in a JPEG's MPF (Multi-Picture Format, APP2) segment, largest first, as
 * absolute file offsets. Many cameras store a ~1600 px preview here, at the end of the file. The
 * MPF segment sits near the start, so the first 64–128 KB of the file is enough to find it.
 */
export function mpfPreviews(head: Uint8Array): ByteRange[] {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) {
    return [];
  }
  let off = 2;
  while (off + 4 <= head.length) {
    if (head[off] !== 0xff) {
      return [];
    }
    const marker = head[off + 1];
    if (marker === 0xda || marker === 0xd9) {
      return [];
    }
    const len = (head[off + 2] << 8) | head[off + 3];
    if (
      marker === 0xe2 &&
      off + 8 + 8 <= head.length &&
      head[off + 4] === 0x4d && // M
      head[off + 5] === 0x50 && // P
      head[off + 6] === 0x46 && // F
      head[off + 7] === 0x00
    ) {
      return parseMpf(head, off + 8, Math.min(head.length, off + 2 + len));
    }
    off += 2 + len;
  }
  return [];
}

function parseMpf(buf: Uint8Array, base: number, end: number): ByteRange[] {
  const little = buf[base] === 0x49;
  if (!little && buf[base] !== 0x4d) {
    return [];
  }
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u16 = (o: number) => v.getUint16(o, little);
  const u32 = (o: number) => v.getUint32(o, little);
  const ifd = base + u32(base + 4);
  if (ifd + 2 > end) {
    return [];
  }
  const n = u16(ifd);
  let count = 0;
  let entriesAt = -1;
  for (let i = 0; i < n && ifd + 2 + (i + 1) * 12 <= end; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    if (tag === 0xb001) {
      count = u32(e + 8);
    } else if (tag === 0xb002) {
      entriesAt = base + u32(e + 8);
    }
  }
  if (count < 2 || count > 32 || entriesAt < 0 || entriesAt + count * 16 > end) {
    return [];
  }
  const out: ByteRange[] = [];
  for (let i = 0; i < count; i++) {
    const e = entriesAt + i * 16;
    const size = u32(e + 4);
    const rel = u32(e + 8);
    if (rel === 0 || size === 0) {
      continue; // the primary image itself
    }
    out.push({ offset: base + rel, length: size });
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * The JPEG's header segments (everything before the image data) as seen in `head`:
 * `complete` is false when `head` ends before the image data starts (more bytes needed to see
 * every segment). `summary` is a short description for diagnostics.
 */
export function jpegSegments(head: Uint8Array): { complete: boolean; summary: string } {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) {
    return { complete: true, summary: 'not a JPEG' };
  }
  const parts: string[] = [];
  let off = 2;
  while (off + 4 <= head.length) {
    if (head[off] !== 0xff) {
      return { complete: true, summary: parts.join(', ') + `, corrupt at ${off}` };
    }
    const marker = head[off + 1];
    if (marker === 0xda) {
      parts.push(`image data @${off}`);
      return { complete: true, summary: parts.join(', ') };
    }
    const len = (head[off + 2] << 8) | head[off + 3];
    let tag = '';
    if (marker >= 0xe0 && marker <= 0xef) {
      const id = String.fromCharCode(...head.subarray(off + 4, Math.min(off + 4 + 12, head.length)))
        .split('\0')[0]
        .replace(/[^\x20-\x7e]/g, '');
      tag = `APP${marker - 0xe0}${id ? `(${id.slice(0, 28)})` : ''}`;
    } else {
      tag = 'FF' + marker.toString(16).toUpperCase();
    }
    parts.push(`${tag} ${(len / 1024).toFixed(1)}KB @${off}`);
    off += 2 + len;
  }
  return { complete: false, summary: parts.join(', ') + ` … (header continues past ${head.length} bytes)` };
}

/** True when bytes look like a baseline/progressive JPEG a browser can decode. */
export function isBrowserJpeg(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false;
  }
  // Find the first SOF marker: C0/C1/C2 are fine; C3 (lossless) is not decodable by browsers.
  let off = 2;
  while (off + 4 <= bytes.length && off < 65536) {
    if (bytes[off] !== 0xff) {
      return false;
    }
    const marker = bytes[off + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return true;
    }
    if (marker === 0xc3 || marker === 0xda) {
      return false;
    }
    off += 2 + ((bytes[off + 2] << 8) | bytes[off + 3]);
  }
  return true; // could not tell from the start; let the decoder try
}

export function formatExposure(seconds: number): string {
  if (seconds >= 1) {
    return `${Number(seconds.toFixed(1))}s`;
  }
  return `1/${Math.round(1 / seconds)}`;
}

/** "2026:10:14 07:42:10" -> "2026-10-14 07:42". */
export function formatExifDate(d: string): string {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/.exec(d);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : d;
}

/** Camera string without the maker repeated ("NIKON CORPORATION" + "NIKON Z 6" -> "NIKON Z 6"). */
export function cameraLabel(info: ExifInfo): string | undefined {
  if (!info.model) {
    return info.make;
  }
  if (!info.make) {
    return info.model;
  }
  const firstWord = info.make.split(/\s+/)[0].toLowerCase();
  return info.model.toLowerCase().startsWith(firstWord) ? info.model : `${info.make} ${info.model}`;
}
