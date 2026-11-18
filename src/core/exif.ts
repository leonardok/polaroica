/**
 * Minimal EXIF reader for the details panel. Reads the TIFF structure found in JPEG APP1
 * segments and in TIFF-based RAW files (NEF, CR2, ARW, DNG, ORF, ...). Only the handful of
 * tags the UI shows. No `vscode` import.
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

const TAG = {
  imageWidth: 0x0100,
  imageHeight: 0x0101,
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
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

/** Parse EXIF from the first bytes of a file (256 KB is plenty for JPEG and most RAW). */
export function readExif(buf: Uint8Array): ExifInfo | undefined {
  if (buf.length < 8) {
    return undefined;
  }
  // JPEG
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
        buf[off + 4] === 0x45 && // E
        buf[off + 5] === 0x78 && // x
        buf[off + 6] === 0x69 && // i
        buf[off + 7] === 0x66 // f
      ) {
        const start = off + 10;
        return parseTiff(buf.subarray(start, Math.min(buf.length, off + 2 + len)));
      }
      off += 2 + len;
    }
    return undefined;
  }
  // TIFF / TIFF-based RAW ("II*\0" or "MM\0*"; ORF and RW2 use other magic numbers)
  if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d)) {
    return parseTiff(buf);
  }
  return undefined;
}

function parseTiff(t: Uint8Array): ExifInfo | undefined {
  if (t.length < 8) {
    return undefined;
  }
  const little = t[0] === 0x49;
  const view = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  const inRange = (o: number, n: number) => o >= 0 && o + n <= t.length;

  const info: ExifInfo = {};

  const typeSize: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  function readValue(entry: number): number | string | undefined {
    const type = u16(entry + 2);
    const count = u32(entry + 4);
    const size = (typeSize[type] ?? 0) * count;
    if (!size) {
      return undefined;
    }
    const valOff = size <= 4 ? entry + 8 : u32(entry + 8);
    if (!inRange(valOff, size)) {
      return undefined;
    }
    switch (type) {
      case 2: {
        let s = '';
        for (let i = 0; i < count; i++) {
          const c = t[valOff + i];
          if (c === 0) {
            break;
          }
          s += String.fromCharCode(c);
        }
        return s.trim();
      }
      case 3:
        return u16(valOff);
      case 4:
        return u32(valOff);
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
  }

  function walk(ifd: number, depth: number): void {
    if (depth > 2 || !inRange(ifd, 2)) {
      return;
    }
    const n = u16(ifd);
    if (n > 1000 || !inRange(ifd + 2, n * 12)) {
      return;
    }
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12;
      const tag = u16(e);
      if (tag === TAG.exifIfd) {
        const sub = readValue(e);
        if (typeof sub === 'number') {
          walk(sub, depth + 1);
        }
        continue;
      }
      const v = readValue(e);
      if (v === undefined) {
        continue;
      }
      const num = typeof v === 'number' ? v : undefined;
      const str = typeof v === 'string' && v ? v : undefined;
      switch (tag) {
        case TAG.make: info.make ??= str; break;
        case TAG.model: info.model ??= str; break;
        case TAG.lensModel: info.lens ??= str; break;
        case TAG.dateTimeOriginal: info.dateTaken ??= str; break;
        case TAG.exposureTime: info.exposureTime ??= num; break;
        case TAG.fNumber: info.fNumber ??= num; break;
        case TAG.iso: info.iso ??= num; break;
        case TAG.focalLength: info.focalLength ??= num; break;
        case TAG.orientation: info.orientation ??= num; break;
        case TAG.pixelX: info.width = num ?? info.width; break;
        case TAG.pixelY: info.height = num ?? info.height; break;
        case TAG.imageWidth: if (depth === 0) { info.width ??= num; } break;
        case TAG.imageHeight: if (depth === 0) { info.height ??= num; } break;
      }
    }
  }

  walk(u32(4), 0);
  return Object.keys(info).length ? info : undefined;
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
