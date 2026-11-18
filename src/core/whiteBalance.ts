/**
 * White balance in Kelvin. A photo has a reference temperature: what the camera balanced it for
 * (RAW: its as-shot white balance) or, for a JPEG, an estimate from the picture's colours. Setting
 * another temperature re-balances the picture: higher = warmer, lower = cooler, as in camera
 * settings. media/adjust.js has the same maths for the photo tab. No `vscode` import.
 */

export const KELVIN_MIN = 2000;
export const KELVIN_MAX = 15000;

/** CIE xy of a black body at `k` Kelvin (Kim et al. cubic fit, 1667–25000 K). */
export function planckXy(k: number): [number, number] {
  const t = Math.max(1667, Math.min(25000, k));
  const i = 1e3 / t;
  const x =
    t <= 4000
      ? -0.2661239 * i * i * i - 0.234358 * i * i + 0.8776956 * i + 0.17991
      : -3.0258469 * i * i * i + 2.1070379 * i * i + 0.2226347 * i + 0.24039;
  const y =
    t <= 2222
      ? -1.1063814 * x * x * x - 1.3481102 * x * x + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x * x * x - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
        : 3.081758 * x * x * x - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
  return [x, y];
}

/** Linear sRGB of that light's white (Y = 1). */
export function whiteRgb(k: number): [number, number, number] {
  const [x, y] = planckXy(k);
  const X = x / y;
  const Z = (1 - x - y) / y;
  return [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
}

/**
 * Per-channel gains (linear light) that turn a picture balanced for `ref` K into one balanced for
 * `k` K, keeping its brightness.
 */
export function kelvinGains(ref: number, k: number): [number, number, number] {
  const a = whiteRgb(ref);
  const b = whiteRgb(k);
  const g: [number, number, number] = [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
  const luma = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / luma, g[1] / luma, g[2] / luma];
}

/**
 * The temperature whose light has this red / blue balance (linear sRGB), searched along the
 * black-body line in even steps of mired.
 */
export function kelvinOfRgb(r: number, b: number): number {
  const want = Math.log(Math.max(r, 1e-6) / Math.max(b, 1e-6));
  let best = 6500;
  let err = Infinity;
  for (let m = 1e6 / KELVIN_MAX; m <= 1e6 / KELVIN_MIN; m += 0.5) {
    const w = whiteRgb(1e6 / m);
    const e = Math.abs(Math.log(w[0] / w[2]) - want);
    if (e < err) {
      err = e;
      best = 1e6 / m;
    }
  }
  return roundKelvin(best);
}

/** Kelvin values are shown and stored to the nearest 10 K. */
export function roundKelvin(k: number): number {
  return Math.round(Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, k)) / 10) * 10;
}

/**
 * A RAW file's as-shot white balance in Kelvin, from LibRaw's colour data: the camera's
 * white-balance multipliers give the colour it treated as neutral, in camera RGB; the camera's
 * matrix turns that into CIE xy, and McCamy's formula into a temperature.
 */
export function asShotKelvin(color: { cam_mul?: number[]; cam_xyz?: number[][] } | undefined): number | undefined {
  const mul = color?.cam_mul;
  const m = color?.cam_xyz;
  if (!mul || !m || mul.length < 3 || m.length < 3 || !(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) {
    return undefined;
  }
  const inv = invert3([m[0].slice(0, 3), m[1].slice(0, 3), m[2].slice(0, 3)]);
  if (!inv) {
    return undefined;
  }
  const n = [1 / mul[0], 1 / mul[1], 1 / mul[2]];
  const xyz = inv.map((r) => r[0] * n[0] + r[1] * n[1] + r[2] * n[2]);
  const s = xyz[0] + xyz[1] + xyz[2];
  if (!(s > 0)) {
    return undefined;
  }
  const x = xyz[0] / s;
  const y = xyz[1] / s;
  const q = (x - 0.332) / (0.1858 - y);
  const k = 449 * q * q * q + 3525 * q * q + 6823.3 * q + 5520.33;
  return Number.isFinite(k) && k > 1000 && k < 40000 ? roundKelvin(k) : undefined;
}

function invert3(m: number[][]): number[][] | undefined {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) {
    return undefined;
  }
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
