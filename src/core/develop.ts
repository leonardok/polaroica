/**
 * The photo tab's adjustments, applied to pixels in the extension host (for export). Mirrors
 * the WebGL shader in media/adjust.js step by step, so an export looks like the photo tab.
 * Also: matching a RAW decode's tones to the camera's own preview. No `vscode` import.
 */
import { Rgba } from './image';
import { CurvePoint, Curves, Edits, isDefault } from './xmp';

/** Monotone cubic (Fritsch–Carlson) through the points, as 256 values 0–1 (same as adjust.js). */
export function curveTable(points: CurvePoint[]): Float32Array {
  const pts = points.slice().sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const out = new Float32Array(256);
  if (n < 2) {
    for (let i = 0; i < 256; i++) out[i] = i / 255;
    return out;
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d: number[] = [];
  const m = new Array<number>(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    let y: number;
    if (x <= xs[0]) {
      y = ys[0];
    } else if (x >= xs[n - 1]) {
      y = ys[n - 1];
    } else {
      while (seg < n - 2 && x > xs[seg + 1]) seg++;
      const hgt = xs[seg + 1] - xs[seg];
      const t = (x - xs[seg]) / hgt;
      const t2 = t * t;
      const t3 = t2 * t;
      y =
        (2 * t3 - 3 * t2 + 1) * ys[seg] +
        (t3 - 2 * t2 + t) * hgt * m[seg] +
        (-2 * t3 + 3 * t2) * ys[seg + 1] +
        (t3 - t2) * hgt * m[seg + 1];
    }
    out[x] = Math.max(0, Math.min(255, y)) / 255;
  }
  return out;
}

/** Per channel, the channel curve after the RGB curve, as 256 bytes each (the shader's LUT texture). */
function lutBytes(curves: Curves): [Uint8Array, Uint8Array, Uint8Array] {
  const master = curveTable(curves.rgb);
  const ch = [curveTable(curves.r), curveTable(curves.g), curveTable(curves.b)];
  const out: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  for (let x = 0; x < 256; x++) {
    const v = Math.round(master[x] * 255);
    for (let c = 0; c < 3; c++) out[c][x] = Math.round(ch[c][v] * 255);
  }
  return out;
}

const toLin = (c: number) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c: number) => (c <= 0 ? 0 : c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Applies the adjustments to an RGBA image in place (alpha untouched). */
export function applyEdits(img: Rgba, e: Edits): Rgba {
  if (isDefault(e)) {
    return img;
  }
  const exp = Math.pow(2, e.exposure);
  const con = e.contrast / 100;
  const hi = e.highlights / 100;
  const sh = e.shadows / 100;
  const wh = e.whites / 100;
  const bl = e.blacks / 100;
  const temp = e.temp / 100;
  const tint = e.tint / 100;
  const vib = e.vibrance / 100;
  const sat = e.saturation / 100;
  const bp = -0.12 * bl;
  const wp = 1 - 0.12 * wh;
  const span = Math.max(wp - bp, 0.05);
  // Exposure, white balance and whites/blacks act on each channel alone: one table per channel.
  const wb = [1 + 0.25 * temp, 1 - 0.18 * tint, 1 - 0.25 * temp];
  const pre = [0, 1, 2].map((c) => {
    const t = new Float32Array(256);
    for (let v = 0; v < 256; v++) t[v] = (toSrgb(toLin(v / 255) * exp * wb[c]) - bp) / span;
    return t;
  });
  const lut = lutBytes(e.curves);
  // The shader samples the 256-entry curve with linear filtering: x * 255 between two entries.
  const curve = (x: number, c: number) => {
    const f = Math.max(0, Math.min(1, x)) * 255;
    const i = Math.min(254, Math.floor(f));
    const t = f - i;
    return (lut[c][i] * (1 - t) + lut[c][i + 1] * t) / 255;
  };
  const d = img.data;
  for (let p = 0; p < d.length; p += 4) {
    let r = pre[0][d[p]];
    let g = pre[1][d[p + 1]];
    let b = pre[2][d[p + 2]];
    // Shadows / highlights: brightness changes masked to the dark / bright tones.
    const L = Math.max(0, Math.min(1, 0.2126 * r + 0.7152 * g + 0.0722 * b));
    const ms = 1 - smoothstep(0, 0.55, L);
    const mh = smoothstep(0.45, 1, L);
    const L2 = Math.max(0, Math.min(1.2, L + 0.28 * sh * ms + 0.28 * hi * mh));
    const k = L2 / Math.max(L, 1e-3);
    r = Math.max(0, Math.min(1, r * k));
    g = Math.max(0, Math.min(1, g * k));
    b = Math.max(0, Math.min(1, b * k));
    // Contrast: an S-curve (or flattening) around mid-grey.
    if (con >= 0) {
      r += (r * r * (3 - 2 * r) - r) * con;
      g += (g * g * (3 - 2 * g) - g) * con;
      b += (b * b * (3 - 2 * b) - b) * con;
    } else {
      r += (0.5 + (r - 0.5) * 0.4 - r) * -con;
      g += (0.5 + (g - 0.5) * 0.4 - g) * -con;
      b += (0.5 + (b - 0.5) * 0.4 - b) * -con;
    }
    // Tone curve.
    r = curve(r, 0);
    g = curve(g, 1);
    b = curve(b, 2);
    // Vibrance (boosts muted colours more) and saturation.
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = Math.max(r, g, b) - Math.min(r, g, b);
    const kk = Math.max(1 + sat + vib * (1 - s), 0);
    d[p] = Math.round(Math.max(0, Math.min(1, l + (r - l) * kk)) * 255);
    d[p + 1] = Math.round(Math.max(0, Math.min(1, l + (g - l) * kk)) * 255);
    d[p + 2] = Math.round(Math.max(0, Math.min(1, l + (b - l) * kk)) * 255);
  }
  return img;
}

/**
 * A RAW decode (16-bit RGB, linear-ish and flat) brought to the look of the camera's own
 * preview JPEG: per channel, the tone curve that gives the decode the preview's histogram.
 * Keeps the RAW's full resolution and detail with the camera's brightness and colours.
 */
export function matchToPreview(raw: { data: Uint16Array; width: number; height: number }, preview: Rgba): Rgba {
  const BINS = 4096; // 16-bit values >> 4
  const n = raw.width * raw.height;
  const src = raw.data;
  // Sample the decode at about the preview's size: fast, and the same scale of detail.
  const step = Math.max(1, Math.floor(Math.sqrt(n / Math.max(1, preview.width * preview.height))));
  const hs = [new Float64Array(BINS), new Float64Array(BINS), new Float64Array(BINS)];
  let count = 0;
  for (let y = 0; y < raw.height; y += step) {
    for (let x = 0; x < raw.width; x += step) {
      const i = (y * raw.width + x) * 3;
      hs[0][src[i] >> 4]++;
      hs[1][src[i + 1] >> 4]++;
      hs[2][src[i + 2] >> 4]++;
      count++;
    }
  }
  const hp = [new Float64Array(256), new Float64Array(256), new Float64Array(256)];
  const pn = preview.width * preview.height;
  for (let i = 0; i < pn; i++) {
    hp[0][preview.data[i * 4]]++;
    hp[1][preview.data[i * 4 + 1]]++;
    hp[2][preview.data[i * 4 + 2]]++;
  }
  const luts = [0, 1, 2].map((c) => {
    const cs = new Float64Array(BINS);
    let a = 0;
    for (let b = 0; b < BINS; b++) {
      a += hs[c][b];
      cs[b] = a / count;
    }
    const cp = new Float64Array(256);
    a = 0;
    for (let b = 0; b < 256; b++) {
      a += hp[c][b];
      cp[b] = a / pn;
    }
    const lut = new Uint8Array(BINS);
    let j = 0;
    for (let b = 0; b < BINS; b++) {
      while (j < 255 && cp[j] < cs[b]) j++;
      const lo = j > 0 ? cp[j - 1] : 0;
      const f = cp[j] > lo ? (cs[b] - lo) / (cp[j] - lo) : 1;
      lut[b] = Math.max(0, Math.min(255, Math.round(j - 1 + f)));
    }
    return lut;
  });
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = luts[0][src[i * 3] >> 4];
    out[i * 4 + 1] = luts[1][src[i * 3 + 1] >> 4];
    out[i * 4 + 2] = luts[2][src[i * 3 + 2] >> 4];
    out[i * 4 + 3] = 255;
  }
  return { data: out, width: raw.width, height: raw.height };
}

/** RGB (3 bytes per pixel) to RGBA. */
export function rgbToRgba(rgb: Uint8Array | Uint8ClampedArray, width: number, height: number): Rgba {
  const n = width * height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = rgb[i * 3];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return { data: out, width, height };
}
