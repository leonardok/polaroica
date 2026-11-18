/**
 * Small pixel helpers for making thumbnails in the extension host (no browser available):
 * area-average downscaling, EXIF orientation, and trimming letterbox bars. RGBA, 8 bits per
 * channel. No `vscode` import.
 */

export interface Rgba {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** Shrinks so the long edge is at most `maxSide`, averaging every source pixel (sharp, no aliasing). */
export function downscale(src: Rgba, maxSide: number): Rgba {
  const { width: sw, height: sh, data: s } = src;
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  if (scale === 1) {
    return src;
  }
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  // Each source pixel adds to the destination pixel it falls in (a box filter, right for the
  // large ratios we use, e.g. 6000 -> 256). Integer sums: a few times faster than floats.
  const acc = new Uint32Array(dw * 4);
  const out = new Uint8ClampedArray(dw * dh * 4);
  // Shrinking by 8× or more: every other pixel in each direction is plenty (each output pixel
  // still averages dozens of samples) and four times less work.
  const step = 1 / scale >= 8 ? 2 : 1;
  const xMap = new Uint32Array(sw);
  const colCount = new Uint32Array(dw);
  for (let x = 0; x < sw; x += step) {
    const dx = Math.min(dw - 1, Math.floor((x * dw) / sw));
    xMap[x] = dx * 4;
    colCount[dx]++;
  }
  let y = 0;
  for (let dy = 0; dy < dh; dy++) {
    const yEnd = dy === dh - 1 ? sh : Math.min(sh, Math.floor(((dy + 1) * sh) / dh));
    acc.fill(0);
    let rows = 0;
    for (; y < yEnd; y += step) {
      rows++;
      let si = y * sw * 4;
      // Colour only: decoded JPEGs are opaque, so alpha is set to 255 below instead of averaged.
      for (let x = 0; x < sw; x += step, si += 4 * step) {
        const ai = xMap[x];
        acc[ai] += s[si];
        acc[ai + 1] += s[si + 1];
        acc[ai + 2] += s[si + 2];
      }
    }
    const o = dy * dw * 4;
    for (let dx = 0; dx < dw; dx++) {
      const n = colCount[dx] * rows || 1;
      // (y may overshoot yEnd by one when stepping; the next row band starts there)
      const ai = dx * 4;
      out[o + ai] = acc[ai] / n;
      out[o + ai + 1] = acc[ai + 1] / n;
      out[o + ai + 2] = acc[ai + 2] / n;
      out[o + ai + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** Applies an EXIF orientation (1–8) so the image is upright. */
export function orient(src: Rgba, orientation: number | undefined): Rgba {
  const o = orientation ?? 1;
  if (o <= 1 || o > 8) {
    return src;
  }
  const { width: w, height: h, data: s } = src;
  const swap = o >= 5;
  const dw = swap ? h : w;
  const dh = swap ? w : h;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let dx: number;
      let dy: number;
      switch (o) {
        case 2: dx = w - 1 - x; dy = y; break;
        case 3: dx = w - 1 - x; dy = h - 1 - y; break;
        case 4: dx = x; dy = h - 1 - y; break;
        case 5: dx = y; dy = x; break;
        case 6: dx = h - 1 - y; dy = x; break;
        case 7: dx = h - 1 - y; dy = w - 1 - x; break;
        default: dx = y; dy = w - 1 - x; break; // 8
      }
      const si = (y * w + x) * 4;
      const di = (dy * dw + dx) * 4;
      out[di] = s[si];
      out[di + 1] = s[si + 1];
      out[di + 2] = s[si + 2];
      out[di + 3] = s[si + 3];
    }
  }
  return { data: out, width: dw, height: dh };
}

/**
 * Removes black bars cameras add when they store a 3:2 photo's EXIF thumbnail as 4:3 (160×120).
 * Only uniform, near-black rows/columns at the edges count, at most a quarter of the size.
 */
export function trimBars(src: Rgba): Rgba {
  const { width: w, height: h, data: s } = src;
  const darkRow = (y: number) => {
    let sum = 0;
    let max = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const l = (s[i] + s[i + 1] + s[i + 2]) / 3;
      sum += l;
      max = Math.max(max, l);
    }
    return sum / w < 10 && max < 40;
  };
  const darkCol = (x: number) => {
    let sum = 0;
    let max = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      const l = (s[i] + s[i + 1] + s[i + 2]) / 3;
      sum += l;
      max = Math.max(max, l);
    }
    return sum / h < 10 && max < 40;
  };
  let top = 0;
  while (top < h / 4 && darkRow(top)) top++;
  let bottom = 0;
  while (bottom < h / 4 && darkRow(h - 1 - bottom)) bottom++;
  let left = 0;
  while (left < w / 4 && darkCol(left)) left++;
  let right = 0;
  while (right < w / 4 && darkCol(w - 1 - right)) right++;
  // Bars come in pairs; a dark photo edge on one side alone is not a bar.
  if (Math.abs(top - bottom) > 2 || (top > 0) !== (bottom > 0)) top = bottom = 0;
  if (Math.abs(left - right) > 2 || (left > 0) !== (right > 0)) left = right = 0;
  if (!top && !bottom && !left && !right) {
    return src;
  }
  const nw = w - left - right;
  const nh = h - top - bottom;
  const out = new Uint8ClampedArray(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const from = ((y + top) * w + left) * 4;
    out.set(s.subarray(from, from + nw * 4), y * nw * 4);
  }
  return { data: out, width: nw, height: nh };
}
