/**
 * Measurements Auto-Rank needs from a photo's pixels (RGBA, ideally ~1000 px on the long edge).
 * No `vscode` import.
 */
import { Rgba } from './image';

export interface Analysis {
  /** Edge sharpness of the sharpest part of the photo (higher = sharper). */
  sharpness: number;
  /** Share (0–1) of the photo covered by blown-out areas. */
  blown: number;
  /** 64-bit difference hash (16 hex chars): near-identical photos differ in few bits. */
  hash: string;
  /**
   * Colour layout: the average colour of each cell of a 12×8 grid (288 bytes, hex). Shots of the
   * same scene and framing match even when people moved; a reframe or another scene doesn't.
   */
  layout?: string;
}

const LAYOUT_W = 12;
const LAYOUT_H = 8;

function colourLayout(img: Rgba): string {
  const { data, width, height } = img;
  const sum = new Float64Array(LAYOUT_W * LAYOUT_H * 3);
  const n = new Float64Array(LAYOUT_W * LAYOUT_H);
  for (let y = 0; y < height; y++) {
    const row = Math.min(LAYOUT_H - 1, Math.floor((y * LAYOUT_H) / height)) * LAYOUT_W;
    for (let x = 0; x < width; x++) {
      const c = row + Math.min(LAYOUT_W - 1, Math.floor((x * LAYOUT_W) / width));
      const i = (y * width + x) * 4;
      sum[c * 3] += data[i];
      sum[c * 3 + 1] += data[i + 1];
      sum[c * 3 + 2] += data[i + 2];
      n[c]++;
    }
  }
  let hex = '';
  for (let c = 0; c < n.length; c++) {
    for (let k = 0; k < 3; k++) {
      hex += Math.round(sum[c * 3 + k] / (n[c] || 1)).toString(16).padStart(2, '0');
    }
  }
  return hex;
}

/** Mean colour difference (0–441) between two layouts, per grid cell; undefined if one is missing. */
export function layoutDistance(a: string | undefined, b: string | undefined): number | undefined {
  if (!a || !b || a.length !== b.length) {
    return undefined;
  }
  let total = 0;
  const cells = a.length / 6;
  for (let c = 0; c < cells; c++) {
    let d = 0;
    for (let k = 0; k < 3; k++) {
      const o = c * 6 + k * 2;
      const diff = parseInt(a.substr(o, 2), 16) - parseInt(b.substr(o, 2), 16);
      d += diff * diff;
    }
    total += Math.sqrt(d);
  }
  return total / cells;
}

function gray(img: Rgba): Float32Array {
  const { data, width, height } = img;
  const g = new Float32Array(width * height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) {
    g[j] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return g;
}

/**
 * Sharpness: variance of the Laplacian (a standard focus measure), computed per tile of an 8×8
 * grid and averaged over the sharpest 15% of tiles. Using the sharpest tiles, not the whole
 * frame, keeps a sharp subject on a soft (bokeh) background from scoring as blurry.
 */
export function sharpness(g: Float32Array, w: number, h: number): number {
  const TILES = 8;
  const sums = new Float64Array(TILES * TILES);
  const sq = new Float64Array(TILES * TILES);
  const counts = new Uint32Array(TILES * TILES);
  for (let y = 1; y < h - 1; y++) {
    const ty = Math.min(TILES - 1, Math.floor((y * TILES) / h));
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i];
      const t = ty * TILES + Math.min(TILES - 1, Math.floor((x * TILES) / w));
      sums[t] += lap;
      sq[t] += lap * lap;
      counts[t]++;
    }
  }
  const variances: number[] = [];
  for (let t = 0; t < TILES * TILES; t++) {
    if (counts[t]) {
      const mean = sums[t] / counts[t];
      variances.push(sq[t] / counts[t] - mean * mean);
    }
  }
  variances.sort((a, b) => b - a);
  const top = variances.slice(0, Math.max(1, Math.round(variances.length * 0.15)));
  return top.reduce((a, b) => a + b, 0) / top.length;
}

/**
 * Blown highlights: share of 16×16 blocks that are mostly (≥ 60%) pure white (luminance ≥ 250).
 * Counting blocks, not pixels, ignores small specular highlights and counts real washed-out areas.
 */
export function blownArea(g: Float32Array, w: number, h: number): number {
  const B = 16;
  let blocks = 0;
  let blown = 0;
  for (let by = 0; by + B <= h; by += B) {
    for (let bx = 0; bx + B <= w; bx += B) {
      let n = 0;
      for (let y = by; y < by + B; y++) {
        const row = y * w;
        for (let x = bx; x < bx + B; x++) {
          if (g[row + x] >= 250) n++;
        }
      }
      blocks++;
      if (n >= B * B * 0.6) blown++;
    }
  }
  return blocks ? blown / blocks : 0;
}

/**
 * dHash with a confidence mask: shrink to 9×8 grey, one bit per "left brighter than right", plus
 * one mask bit per comparison that is clear-cut (differs by more than ~1% of full scale).
 * Flat, evenly lit areas give near-equal neighbours whose bits flip with the slightest blur or
 * noise; the mask lets the comparison ignore them. Returned as 32 hex chars: hash then mask.
 */
export function dhash(g: Float32Array, w: number, h: number): string {
  const cells = new Float64Array(9 * 8);
  const counts = new Uint32Array(9 * 8);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(7, Math.floor((y * 8) / h));
    for (let x = 0; x < w; x++) {
      const c = cy * 9 + Math.min(8, Math.floor((x * 9) / w));
      cells[c] += g[y * w + x];
      counts[c]++;
    }
  }
  let hash = '';
  let mask = '';
  for (let y = 0; y < 8; y++) {
    let hb = 0;
    let mb = 0;
    for (let x = 0; x < 8; x++) {
      const a = cells[y * 9 + x] / (counts[y * 9 + x] || 1);
      const b = cells[y * 9 + x + 1] / (counts[y * 9 + x + 1] || 1);
      hb = (hb << 1) | (a > b ? 1 : 0);
      mb = (mb << 1) | (Math.abs(a - b) > 2.5 ? 1 : 0);
    }
    hash += hb.toString(16).padStart(2, '0');
    mask += mb.toString(16).padStart(2, '0');
  }
  return hash + mask;
}

const bits = (x: number) => {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>= 1;
  }
  return n;
};

/**
 * Distance between two hashes, scaled to 0–64. With masks: a comparison clear-cut in both photos
 * counts when it differs; one clear-cut in only one photo (structure here, flat there) counts as
 * a difference too; comparisons flat in both are ignored. Two nearly featureless photos are alike.
 */
export function hamming(a: string, b: string): number {
  if (a.length === 32 && b.length === 32) {
    let diff = 0;
    let compared = 0;
    for (let i = 0; i < 16; i += 2) {
      const ha = parseInt(a.slice(i, i + 2), 16);
      const hb = parseInt(b.slice(i, i + 2), 16);
      const ma = parseInt(a.slice(16 + i, 18 + i), 16);
      const mb = parseInt(b.slice(16 + i, 18 + i), 16);
      diff += bits(((ha ^ hb) & ma & mb) | (ma ^ mb));
      compared += bits(ma | mb);
    }
    return compared < 8 ? 0 : Math.round((diff * 64) / compared);
  }
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 2) {
    d += bits(parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16));
  }
  return d;
}

export function analyzePixels(img: Rgba): Analysis {
  const g = gray(img);
  return {
    sharpness: sharpness(g, img.width, img.height),
    blown: blownArea(g, img.width, img.height),
    hash: dhash(g, img.width, img.height),
    layout: colourLayout(img),
  };
}
