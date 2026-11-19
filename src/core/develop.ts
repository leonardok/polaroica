/**
 * The photo tab's adjustments, applied to pixels in the extension host (for export). Mirrors
 * the WebGL shader in media/adjust.js step by step, so an export looks like the photo tab.
 * Also: matching a RAW decode's tones to the camera's own preview. No `vscode` import.
 */
import { downscale, Rgba } from './image';
import { kelvinGains } from './whiteBalance';
import { CurvePoint, Curves, Edits, hasKelvin, isDefault } from './xmp';

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

// ---- large-scale maps: Clarity and Dehaze ----------------------------------------------

/** Clarity and Dehaze look at the picture through a copy this size (long side), whatever the photo's size. */
export const MAP_SIDE = 384;

/**
 * What Clarity and Dehaze need, worked out once per photo from a small copy (same as
 * toneMaps() in media/adjust.js): `base` is the blurred log2 luminance (the "large shapes"
 * Clarity measures detail against), `trans` how much of the scene shows through the haze at each
 * point (dark channel prior), `air` the colour of the haze (linear).
 */
export interface ToneMaps {
  width: number;
  height: number;
  base: Float32Array;
  trans: Float32Array;
  air: [number, number, number];
}

const LIN8 = new Float32Array(256).map((_, i) => toLin(i / 255));
const LOG_EPS = 1 / 1024;

function gaussBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + Math.max(0, Math.min(w - 1, x + i))];
      tmp[y * w + x] = a;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += k[i + r] * tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x];
      out[y * w + x] = a;
    }
  }
  return out;
}

function minFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = -r; i <= r; i++) m = Math.min(m, src[y * w + Math.max(0, Math.min(w - 1, x + i))]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let i = -r; i <= r; i++) m = Math.min(m, tmp[Math.max(0, Math.min(h - 1, y + i)) * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

/** The maps, from a copy of the photo at most MAP_SIDE on its long side. */
export function toneMaps(small: Rgba): ToneMaps {
  const { width: w, height: h, data: d } = small;
  const n = w * h;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const logY = new Float32Array(n);
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = LIN8[d[i * 4]];
    G[i] = LIN8[d[i * 4 + 1]];
    B[i] = LIN8[d[i * 4 + 2]];
    logY[i] = Math.log2(0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i] + LOG_EPS);
    m[i] = Math.min(R[i], G[i], B[i]);
  }
  const base = gaussBlur(logY, w, h, 3);
  // The haze's colour: the average of the 0.1% of pixels with the brightest dark channel.
  const dark = minFilter(m, w, h, 2);
  const sorted = Float32Array.from(dark).sort();
  const cut = sorted[n - Math.max(1, Math.floor(n * 0.001))];
  const air: [number, number, number] = [0, 0, 0];
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (dark[i] >= cut) {
      air[0] += R[i];
      air[1] += G[i];
      air[2] += B[i];
      k++;
    }
  }
  for (let c = 0; c < 3; c++) air[c] = Math.max(0.05, air[c] / k);
  for (let i = 0; i < n; i++) m[i] = Math.min(R[i] / air[0], G[i] / air[1], B[i] / air[2]);
  const dn = minFilter(m, w, h, 2);
  for (let i = 0; i < n; i++) dn[i] = 1 - 0.95 * dn[i];
  const trans = gaussBlur(dn, w, h, 1.5);
  for (let i = 0; i < n; i++) trans[i] = Math.max(0, Math.min(1, trans[i]));
  return { width: w, height: h, base, trans, air };
}

// ---- fine detail: Sharpness, Noise, Moiré, Defringe ------------------------------------

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Whether any of the slider that look at neighbouring pixels is set. */
export function hasDetail(e: Edits): boolean {
  return !!(e.sharpness || e.noise || e.moire || e.defringe);
}

/**
 * Sharpness, Noise, Moiré and Defringe on the photo as decoded (sRGB, 0–1), each pixel from its
 * 5×5 neighbourhood: the `detail()` step of the shader in media/adjust.js. Returns RGB floats.
 */
export function detailStage(img: Rgba, e: Pick<Edits, 'sharpness' | 'noise' | 'moire' | 'defringe'>): Float32Array {
  const { width: w, height: h, data: d } = img;
  const n = w * h;
  const sharp = e.sharpness / 100;
  const noise = e.noise / 100;
  const moire = e.moire / 100;
  const fringe = e.defringe / 100;
  const S = new Float32Array(n * 3);
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    S[i * 3] = d[i * 4] / 255;
    S[i * 3 + 1] = d[i * 4 + 1] / 255;
    S[i * 3 + 2] = d[i * 4 + 2] / 255;
    Y[i] = luma(S[i * 3], S[i * 3 + 1], S[i * 3 + 2]);
  }
  const sr = 0.02 + 0.1 * noise;
  const inv2sr2 = 1 / (2 * sr * sr);
  const wG = new Float32Array(25);
  const wB = new Float32Array(25);
  for (let j = -2, t = 0; j <= 2; j++) {
    for (let i = -2; i <= 2; i++, t++) {
      const d2 = i * i + j * j;
      wG[t] = Math.exp(-d2 / 2); // σ 1
      wB[t] = Math.exp(-d2 / 4.5); // σ 1.5
    }
  }
  const out = new Float32Array(n * 3);
  const row = new Int32Array(5);
  const col = new Int32Array(5);
  const row2 = new Int32Array(5);
  const col2 = new Int32Array(5);
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < 5; k++) {
      row[k] = Math.max(0, Math.min(h - 1, y + k - 2)) * w;
      row2[k] = Math.max(0, Math.min(h - 1, y + 2 * (k - 2))) * w;
    }
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 5; k++) {
        col[k] = Math.max(0, Math.min(w - 1, x + k - 2));
        col2[k] = Math.max(0, Math.min(w - 1, x + 2 * (k - 2)));
      }
      const c = y * w + x;
      const cr = S[c * 3];
      const cg = S[c * 3 + 1];
      const cb = S[c * 3 + 2];
      const yc = Y[c];
      let gr = 0, gg = 0, gb = 0, gw = 0;
      let br = 0, bg = 0, bb = 0, bw = 0;
      let ymin = yc;
      let ymax = yc;
      for (let j = 0, t = 0; j < 5; j++) {
        for (let i = 0; i < 5; i++, t++) {
          const q = row[j] + col[i];
          const qr = S[q * 3];
          const qg = S[q * 3 + 1];
          const qb = S[q * 3 + 2];
          const yq = Y[q];
          gr += qr * wG[t];
          gg += qg * wG[t];
          gb += qb * wG[t];
          gw += wG[t];
          if (noise) {
            const dy = yq - yc;
            const wb = wB[t] * Math.exp(-dy * dy * inv2sr2);
            br += qr * wb;
            bg += qg * wb;
            bb += qb * wb;
            bw += wb;
          }
          if (yq < ymin) ymin = yq;
          if (yq > ymax) ymax = yq;
        }
      }
      gr /= gw;
      gg /= gw;
      gb /= gw;
      let r = cr, g = cg, b = cb;
      if (noise) {
        r += (br / bw - r) * noise;
        g += (bg / bw - g) * noise;
        b += (bb / bw - b) * noise;
      }
      if (moire) {
        // Colour (not brightness) averaged over a wider area.
        let mr = 0, mg = 0, mb = 0, mw = 0;
        for (let j = 0, t = 0; j < 5; j++) {
          for (let i = 0; i < 5; i++, t++) {
            const q = row2[j] + col2[i];
            const yq = Y[q];
            mr += (S[q * 3] - yq) * wG[t];
            mg += (S[q * 3 + 1] - yq) * wG[t];
            mb += (S[q * 3 + 2] - yq) * wG[t];
            mw += wG[t];
          }
        }
        const l = luma(r, g, b);
        r = l + (r - l) + (mr / mw - (r - l)) * moire;
        g = l + (g - l) + (mg / mw - (g - l)) * moire;
        b = l + (b - l) + (mb / mw - (b - l)) * moire;
      }
      if (fringe) {
        // Purple or green at a hard edge: take the colour out.
        const edge = smoothstep(0.1, 0.35, ymax - ymin);
        const purple = smoothstep(0.02, 0.1, Math.min(r - g, b - g));
        const green = smoothstep(0.02, 0.1, Math.min(g - r, g - b));
        const f = fringe * edge * Math.max(purple, green);
        const l = luma(r, g, b);
        r += (l - r) * f;
        g += (l - g) * f;
        b += (l - b) * f;
      }
      if (sharp > 0) {
        // Unsharp mask on brightness only, so colours don't fringe.
        const dl = (yc - luma(gr, gg, gb)) * sharp * 1.5;
        r += dl;
        g += dl;
        b += dl;
      } else if (sharp < 0) {
        r += (gr - r) * -sharp;
        g += (gg - g) * -sharp;
        b += (gb - b) * -sharp;
      }
      out[c * 3] = Math.max(0, Math.min(1, r));
      out[c * 3 + 1] = Math.max(0, Math.min(1, g));
      out[c * 3 + 2] = Math.max(0, Math.min(1, b));
    }
  }
  return out;
}

/** The Color tint's colour at full strength (hue 0–359), as the shader's u_tint. */
export function tintColor(hue: number): [number, number, number] {
  const h = (((hue % 360) + 360) % 360) / 360;
  const c = (v: number) => Math.max(0, Math.min(1, v));
  return [c(Math.abs(h * 6 - 3) - 1), c(2 - Math.abs(h * 6 - 2)), c(2 - Math.abs(h * 6 - 4))];
}

/** A colour moved back into 0–1 keeping its brightness (W3C "ClipColor"). */
function clipColor(c: [number, number, number]): [number, number, number] {
  const l = luma(c[0], c[1], c[2]);
  const n = Math.min(c[0], c[1], c[2]);
  const x = Math.max(c[0], c[1], c[2]);
  if (n < 0) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * l) / Math.max(l - n, 1e-6);
  if (x > 1) for (let i = 0; i < 3; i++) c[i] = l + ((c[i] - l) * (1 - l)) / Math.max(x - l, 1e-6);
  return c;
}

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
  const vib = e.vibrance / 100;
  const sat = e.saturation / 100;
  const cl = e.clarity / 100;
  const dh = e.dehaze / 100;
  const tAmt = (e.colorAmount / 100) * 0.6;
  const tint = tintColor(e.colorHue);
  const tintL = luma(tint[0], tint[1], tint[2]);
  const bp = -0.12 * bl;
  const wp = 1 - 0.12 * wh;
  const span = Math.max(wp - bp, 0.05);
  // Exposure, white balance and whites/blacks act on each channel alone: one table per channel.
  const wb = whiteBalanceGains(e);
  const pre = [0, 1, 2].map((c) => {
    const t = new Float32Array(256);
    for (let v = 0; v < 256; v++) t[v] = (toSrgb(toLin(v / 255) * exp * wb[c]) - bp) / span;
    return t;
  });
  // Maps and neighbourhoods come from the photo as decoded, before anything below changes it.
  const maps = cl || dh ? toneMaps(downscale(img, MAP_SIDE)) : undefined;
  const det = hasDetail(e) ? detailStage(img, e) : undefined;
  const lut = lutBytes(e.curves);
  // The shader samples the 256-entry curve with linear filtering: x * 255 between two entries.
  const curve = (x: number, c: number) => {
    const f = Math.max(0, Math.min(1, x)) * 255;
    const i = Math.min(254, Math.floor(f));
    const t = f - i;
    return (lut[c][i] * (1 - t) + lut[c][i + 1] * t) / 255;
  };
  const { width: W, height: H, data: d } = img;
  // A map value at a photo pixel, with the GPU's linear filtering (texel centres, clamped edges).
  const mx = new Int32Array(W);
  const mfx = new Float32Array(W);
  if (maps) {
    for (let x = 0; x < W; x++) {
      const u = Math.max(0, Math.min(maps.width - 1, ((x + 0.5) / W) * maps.width - 0.5));
      mx[x] = Math.min(maps.width - 2, Math.floor(u));
      mfx[x] = u - mx[x];
      if (maps.width === 1) (mx[x] = 0), (mfx[x] = 0);
    }
  }
  for (let y = 0, p = 0; y < H; y++) {
    let my = 0;
    let mfy = 0;
    if (maps) {
      const v = Math.max(0, Math.min(maps.height - 1, ((y + 0.5) / H) * maps.height - 0.5));
      my = Math.max(0, Math.min(maps.height - 2, Math.floor(v)));
      mfy = maps.height === 1 ? 0 : v - my;
    }
    for (let x = 0; x < W; x++, p += 4) {
      let r: number;
      let g: number;
      let b: number;
      if (!maps && !det) {
        r = pre[0][d[p]];
        g = pre[1][d[p + 1]];
        b = pre[2][d[p + 2]];
      } else {
        const q = (p >> 2) * 3;
        let lr = det ? toLin(det[q]) : LIN8[d[p]];
        let lg = det ? toLin(det[q + 1]) : LIN8[d[p + 1]];
        let lb = det ? toLin(det[q + 2]) : LIN8[d[p + 2]];
        let dd = 0;
        if (maps) {
          const at = (m: Float32Array) => {
            const i0 = my * maps.width + mx[x];
            const i1 = maps.height === 1 ? i0 : i0 + maps.width;
            const x1 = maps.width === 1 ? 0 : 1;
            const top = m[i0] + (m[i0 + x1] - m[i0]) * mfx[x];
            const bot = m[i1] + (m[i1 + x1] - m[i1]) * mfx[x];
            return top + (bot - top) * mfy;
          };
          if (cl) dd = Math.max(-2, Math.min(2, Math.log2(luma(lr, lg, lb) + LOG_EPS) - at(maps.base)));
          if (dh > 0) {
            const tt = Math.max(1 - dh * (1 - at(maps.trans)), 0.2);
            lr = Math.max(0, (lr - maps.air[0]) / tt + maps.air[0]);
            lg = Math.max(0, (lg - maps.air[1]) / tt + maps.air[1]);
            lb = Math.max(0, (lb - maps.air[2]) / tt + maps.air[2]);
          } else if (dh < 0) {
            lr += (maps.air[0] - lr) * -dh * 0.5;
            lg += (maps.air[1] - lg) * -dh * 0.5;
            lb += (maps.air[2] - lb) * -dh * 0.5;
          }
        }
        lr *= exp * wb[0];
        lg *= exp * wb[1];
        lb *= exp * wb[2];
        if (cl) {
          // Local contrast, strongest in the mid tones.
          const lm = Math.max(0, Math.min(1, toSrgb(luma(lr, lg, lb))));
          const k = Math.pow(2, Math.max(-1.5, Math.min(1.5, cl * 0.8 * dd * 4 * lm * (1 - lm))));
          lr *= k;
          lg *= k;
          lb *= k;
        }
        r = (toSrgb(lr) - bp) / span;
        g = (toSrgb(lg) - bp) / span;
        b = (toSrgb(lb) - bp) / span;
      }
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
      r = Math.max(0, Math.min(1, l + (r - l) * kk));
      g = Math.max(0, Math.min(1, l + (g - l) * kk));
      b = Math.max(0, Math.min(1, l + (b - l) * kk));
      if (tAmt) {
        // Color: the tint's hue at this pixel's brightness, laid over it.
        const l2 = luma(r, g, b);
        const t = clipColor([tint[0] + l2 - tintL, tint[1] + l2 - tintL, tint[2] + l2 - tintL]);
        r += (t[0] - r) * tAmt;
        g += (t[1] - g) * tAmt;
        b += (t[2] - b) * tAmt;
      }
      d[p] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      d[p + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      d[p + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
    }
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

/**
 * White balance as per-channel gains in linear light (the shader's u_wb): the relative
 * Temperature of older edits, Tint, and a Kelvin white balance against the photo's own.
 */
export function whiteBalanceGains(e: Pick<Edits, 'temp' | 'tint' | 'kelvin' | 'kelvinRef'>): [number, number, number] {
  const temp = e.temp / 100;
  const tint = e.tint / 100;
  const g: [number, number, number] = [1 + 0.25 * temp, 1 - 0.18 * tint, 1 - 0.25 * temp];
  if (hasKelvin(e)) {
    const k = kelvinGains(e.kelvinRef, e.kelvin);
    g[0] *= k[0];
    g[1] *= k[1];
    g[2] *= k[2];
  }
  return g;
}
