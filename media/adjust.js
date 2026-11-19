// Photo adjustments for the photo tab: WebGL renderer, tone-curve maths, histogram and the
// ADJUST panel UI. Non-destructive: the settings are saved to .sidecar/<photo>.xmp by the
// extension; the photo file is never changed. Loaded after common.js.
(function () {
  const { h, icon } = window.polaroica;

  const SLIDERS = [
    { id: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.05, group: 'light' },
    { id: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, group: 'light' },
    { id: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, group: 'light' },
    { id: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, group: 'light' },
    { id: 'whites', label: 'Whites', min: -100, max: 100, step: 1, group: 'light' },
    { id: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1, group: 'light' },
    { id: 'temp', label: 'Temp', min: -100, max: 100, step: 1, group: 'color', track: 'linear-gradient(90deg, #4a7fd1, #e8e8e8 50%, #d9a54a)', title: 'Temperature: below 0 cooler, above 0 warmer' },
    { id: 'tint', label: 'Tint', min: -100, max: 100, step: 1, group: 'color', track: 'linear-gradient(90deg, #5cb85c, #c562c5)' },
    { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, group: 'color' },
    { id: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, group: 'color', track: 'linear-gradient(90deg, #7a7a7a, #d9534f)' },
    { id: 'colorHue', label: 'Color', min: 0, max: 359, step: 1, group: 'tint', track: 'linear-gradient(90deg, #f00, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00)', title: 'Color: a tint laid over the picture · set its strength below' },
    { id: 'colorAmount', label: 'Strength', min: 0, max: 100, step: 1, group: 'tint', title: 'How strongly the Color tint is laid over the picture' },
    { id: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1, group: 'presence', title: 'Local contrast in the mid tones' },
    { id: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 1, group: 'presence', title: 'Removes (or adds) haze and fog' },
    { id: 'sharpness', label: 'Sharpness', min: -100, max: 100, step: 1, group: 'detail', title: 'Sharpens fine detail · below 0 softens · view at 1:1 to judge' },
    { id: 'noise', label: 'Noise', min: 0, max: 100, step: 1, group: 'detail', title: 'Smooths out grain in flat areas · view at 1:1 to judge' },
    { id: 'moire', label: 'Moiré', min: 0, max: 100, step: 1, group: 'detail', title: 'Removes colour moiré and colour noise' },
    { id: 'defringe', label: 'Defringe', min: 0, max: 100, step: 1, group: 'detail', title: 'Removes purple and green fringes along hard edges' },
  ];
  const CHANNELS = ['rgb', 'r', 'g', 'b'];
  const IDENTITY = () => [
    [0, 0],
    [255, 255],
  ];

  function defaults() {
    const e = { curves: { rgb: IDENTITY(), r: IDENTITY(), g: IDENTITY(), b: IDENTITY() }, kelvin: 0, kelvinRef: 0 };
    for (const s of SLIDERS) {
      e[s.id] = 0;
    }
    return e;
  }

  // ---- white balance in Kelvin (same maths as src/core/whiteBalance.ts) -------------------

  const KELVIN_MIN = 2000;
  const KELVIN_MAX = 15000;
  const roundKelvin = (k) => Math.round(Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, k)) / 10) * 10;
  const hasKelvin = (e) => e.kelvin > 0 && e.kelvinRef > 0 && e.kelvin !== e.kelvinRef;

  function planckXy(k) {
    const t = Math.max(1667, Math.min(25000, k));
    const i = 1e3 / t;
    const x = t <= 4000 ? -0.2661239 * i ** 3 - 0.234358 * i * i + 0.8776956 * i + 0.17991 : -3.0258469 * i ** 3 + 2.1070379 * i * i + 0.2226347 * i + 0.24039;
    const y =
      t <= 2222
        ? -1.1063814 * x ** 3 - 1.3481102 * x * x + 2.18555832 * x - 0.20219683
        : t <= 4000
          ? -0.9549476 * x ** 3 - 1.37418593 * x * x + 2.09137015 * x - 0.16748867
          : 3.081758 * x ** 3 - 5.8733867 * x * x + 3.75112997 * x - 0.37001483;
    return [x, y];
  }
  function whiteRgb(k) {
    const [x, y] = planckXy(k);
    const X = x / y;
    const Z = (1 - x - y) / y;
    return [3.2404542 * X - 1.5371385 - 0.4985314 * Z, -0.969266 * X + 1.8760108 + 0.041556 * Z, 0.0556434 * X - 0.2040259 + 1.0572252 * Z];
  }
  /** Gains (linear light) that re-balance a picture balanced for `ref` K to `k` K. */
  function kelvinGains(ref, k) {
    const a = whiteRgb(ref);
    const b = whiteRgb(k);
    const g = [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
    const l = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
    return g.map((v) => v / l);
  }
  /** The temperature whose light has this red / blue balance (linear). */
  function kelvinOfRgb(r, b) {
    const want = Math.log(Math.max(r, 1e-6) / Math.max(b, 1e-6));
    let best = 6500;
    let err = Infinity;
    for (let m = 1e6 / KELVIN_MAX; m <= 1e6 / KELVIN_MIN; m += 0.5) {
      const w = whiteRgb(1e6 / m);
      const d = Math.abs(Math.log(w[0] / w[2]) - want);
      if (d < err) {
        err = d;
        best = 1e6 / m;
      }
    }
    return roundKelvin(best);
  }
  /** White balance as gains in linear light (the shader's u_wb); same as whiteBalanceGains() in develop.ts. */
  function wbGains(e) {
    const t = (e.temp || 0) / 100;
    const n = (e.tint || 0) / 100;
    const g = [1 + 0.25 * t, 1 - 0.18 * n, 1 - 0.25 * t];
    if (hasKelvin(e)) {
      const k = kelvinGains(e.kelvinRef, e.kelvin);
      for (let c = 0; c < 3; c++) g[c] *= k[c];
    }
    return g;
  }
  /**
   * A JPEG has no recorded temperature: estimate the light from the picture itself (average colour
   * of the mid tones, leaving out near-black and clipped pixels), as a point on the Kelvin scale.
   */
  function estimateKelvin(bitmap) {
    const s = 96 / Math.max(bitmap.width, bitmap.height);
    const w = Math.max(1, Math.round(bitmap.width * s));
    const hh = Math.max(1, Math.round(bitmap.height * s));
    const ctx = new OffscreenCanvas(w, hh).getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, hh);
    const px = ctx.getImageData(0, 0, w, hh).data;
    const lin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
    let r = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      const m = Math.max(px[i], px[i + 1], px[i + 2]);
      if (m < 12 || m > 245) continue;
      r += lin(px[i]);
      b += lin(px[i + 2]);
      n++;
    }
    return n ? kelvinOfRgb(r, b) : 6500;
  }
  /** The relative Temp (−100…100) that warms or cools as much as moving from `ref` K to `k` K. */
  function tempOfKelvin(ref, k) {
    if (!(ref > 0 && k > 0) || ref === k) return 0;
    const g = kelvinGains(ref, k);
    const q = g[0] / g[2];
    return Math.round(clamp(((q - 1) / (q + 1) / 0.25) * 100, -100, 100));
  }

  // ---- Auto -------------------------------------------------------------------------------

  /** A small copy of the photo as loaded (before any edits): what Auto looks at. */
  function samplePixels(bitmap) {
    const s = Math.min(1, 192 / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s));
    const hh = Math.max(1, Math.round(bitmap.height * s));
    const ctx = new OffscreenCanvas(w, hh).getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, hh);
    return ctx.getImageData(0, 0, w, hh);
  }

  const LIN = new Float32Array(256).map((_, i) => ((i /= 255) <= 0.04045 ? i / 12.92 : Math.pow((i + 0.055) / 1.055, 2.4)));
  const toSrgb = (c) => (c <= 0 ? 0 : c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.min(c, 4), 1 / 2.4) - 0.055);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const BINS = 256;
  /** The value below which a share `q` of a histogram's weight lies (bins over 0–1). */
  function quantile(hist, total, q) {
    let acc = 0;
    const want = q * total;
    for (let i = 0; i < BINS; i++) {
      acc += hist[i];
      if (acc >= want) return (i + 0.5) / BINS;
    }
    return 1;
  }

  /**
   * How much each pixel counts when judging brightness: faces (from Auto-Rank, when it has run
   * with People) carry most of the weight; otherwise the middle of the frame counts more than
   * the edges. Blown light sources and sky count less.
   */
  function meteringWeights(sample, faces) {
    const { width: w, height: hh, data: px } = sample;
    const wt = new Float32Array(w * hh);
    const inFace = new Uint8Array(w * hh);
    let nFace = 0;
    for (const f of faces || []) {
      const x0 = Math.floor(f[0] * w);
      const y0 = Math.floor(f[1] * hh);
      const x1 = Math.ceil((f[0] + f[2]) * w);
      const y1 = Math.ceil((f[1] + f[3]) * hh);
      for (let y = Math.max(0, y0); y < Math.min(hh, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
          if (!inFace[y * w + x]) nFace++;
          inFace[y * w + x] = 1;
        }
      }
    }
    let other = 0;
    for (let y = 0, j = 0; y < hh; y++) {
      for (let x = 0; x < w; x++, j++) {
        const dx = (x + 0.5) / w - 0.5;
        const dy = (y + 0.5) / hh - 0.45; // subjects sit a little above the middle
        let v = 0.5 + Math.exp(-(dx * dx + dy * dy) / (2 * 0.22 * 0.22));
        const i = j * 4;
        if (Math.max(px[i], px[i + 1], px[i + 2]) >= 250) v *= 0.3;
        wt[j] = v;
        if (!inFace[j]) other += v;
      }
    }
    if (nFace) {
      // Faces get 70% of the say, however small they are.
      const each = (0.7 * other) / (0.3 * nFace);
      for (let j = 0; j < wt.length; j++) if (inFace[j]) wt[j] = each;
    }
    return { wt, hasFaces: nFace > 0 };
  }

  /**
   * White balance: the light estimated from the pixels that are probably grey or white in reality.
   * First the overall colour cast of the mid tones (leaving out strongly coloured, black and blown
   * pixels); then only the pixels close to that cast count — a grey wall under orange light is
   * close to it, a face or a green leaf is not. Of those, a "shades of grey" average that leans on
   * the brighter ones. Goes part of the way: less for RAW (the camera's own balance is usually
   * close), less for night scenes (their blue or orange is the point) and less again when few
   * pixels look neutral (a sunset, a forest).
   */
  function autoWhiteBalance(px, ref, raw, lowKey) {
    const total = px.length / 4;
    const out = { temp: 0, tint: 0, gains: [1, 1, 1] };
    if (!(ref > 0)) return out;
    const usable = (i) => {
      const hi = Math.max(px[i], px[i + 1], px[i + 2]);
      const lo = Math.min(px[i], px[i + 1], px[i + 2]);
      return hi >= 40 && hi <= 245 && (hi - lo) / hi <= 0.5;
    };
    const chroma = (i) => {
      const G = LIN[px[i + 1]] + 1e-4;
      return [Math.log((LIN[px[i]] + 1e-4) / G), Math.log((LIN[px[i + 2]] + 1e-4) / G)];
    };
    let mr = 0;
    let mb = 0;
    let m = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (!usable(i)) continue;
      const [cr, cb] = chroma(i);
      mr += cr;
      mb += cb;
      m++;
    }
    if (m < total * 0.05) return out;
    mr /= m;
    mb /= m;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (!usable(i)) continue;
      const [cr, cb] = chroma(i);
      if ((cr - mr) ** 2 + (cb - mb) ** 2 > 0.2 * 0.2) continue;
      const R = LIN[px[i]];
      const G = LIN[px[i + 1]];
      const B = LIN[px[i + 2]];
      r += R ** 4;
      g += G ** 4;
      b += B ** 4;
      n++;
    }
    if (n < total * 0.03) return out;
    r = Math.pow(r, 0.25);
    g = Math.pow(g, 0.25);
    b = Math.pow(b, 0.25);
    const confidence = clamp(n / total / 0.25, 0.3, 1);
    const strength = (raw ? 0.3 : 0.5) * confidence * (lowKey ? 0.4 : 1);
    const w = whiteRgb(ref);
    const neutral = kelvinOfRgb(w[0] * r, w[2] * b);
    const cap = raw ? 30 : 60; // mired
    const shift = clamp(strength * (1e6 / neutral - 1e6 / ref), -cap, cap);
    if (Math.abs(shift) >= 6) {
      out.temp = tempOfKelvin(ref, roundKelvin(1e6 / (1e6 / ref + shift)));
    }
    // Green / magenta: what is left once the warm / cool cast is fully gone. A scene that is
    // green all over (a forest, a lawn) is left alone.
    const kg = kelvinGains(ref, neutral);
    const green = (g * kg[1]) / Math.sqrt(r * kg[0] * b * kg[2]);
    const greenScene = green > 1 && mr < -0.25 && mb < -0.25;
    const gain = 1 + 0.6 * strength * (1 / green - 1); // tint moves green by 1 - 0.18 * tint/100
    out.tint = greenScene ? 0 : Math.round(clamp(((1 - gain) / 0.18) * 100, -10, 10));
    if (Math.abs(out.tint) < 4) out.tint = 0;
    out.gains = wbGains({ temp: out.temp, tint: out.tint, kelvin: 0, kelvinRef: 0 });
    return out;
  }

  /**
   * Auto: Light and Color slider values for a balanced picture. It tries settings on a small copy
   * of the original, drawn with the same maths as the photo itself, and keeps those that score
   * best: the subject (faces, or the middle of the frame) at a pleasant brightness for the kind of
   * scene, nothing newly blown or crushed, the full range of tones used, enough contrast — and no
   * more change than needed. Only ordinary sliders are set (so it can be fine-tuned or undone);
   * the tone curve and Saturation are kept. The same photo always gets the same values.
   *
   * `context`: { faces?: [x, y, w, h][] (0–1, upright), raw?: boolean }.
   */
  function autoEdits(sample, refKelvin, current, context) {
    const ctx = context || {};
    const px = sample.data;
    const n = px.length / 4;
    const roughKey = (() => {
      const lum = new Float32Array(n);
      for (let j = 0, i = 0; j < n; j++, i += 4) lum[j] = 0.2126 * LIN[px[i]] + 0.7152 * LIN[px[i + 1]] + 0.0722 * LIN[px[i + 2]];
      lum.sort();
      return toSrgb(lum[n >> 1]);
    })();
    const wb = autoWhiteBalance(px, refKelvin > 0 ? roundKelvin(refKelvin) : 0, !!ctx.raw, roughKey < 0.15);
    const { wt, hasFaces } = meteringWeights(sample, ctx.faces);

    // The pixels in linear light with the new white balance, and what the original looks like.
    const R = new Float32Array(n);
    const G = new Float32Array(n);
    const B = new Float32Array(n);
    const lumW = new Float64Array(BINS);
    const lumU = new Float64Array(BINS);
    let wSum = 0;
    let clipped0 = 0;
    let crushed0 = 0;
    let sat = 0;
    for (let j = 0, i = 0; j < n; j++, i += 4) {
      R[j] = LIN[px[i]] * wb.gains[0];
      G[j] = LIN[px[i + 1]] * wb.gains[1];
      B[j] = LIN[px[i + 2]] * wb.gains[2];
      const hi = Math.max(px[i], px[i + 1], px[i + 2]);
      const lo = Math.min(px[i], px[i + 1], px[i + 2]);
      if (hi >= 252) clipped0++;
      if (hi <= 3) crushed0++;
      sat += (hi - lo) / 255;
      const s = toSrgb(0.2126 * R[j] + 0.7152 * G[j] + 0.0722 * B[j]);
      const bin = Math.min(BINS - 1, Math.floor(clamp(s, 0, 1) * BINS));
      lumW[bin] += wt[j];
      lumU[bin]++;
      wSum += wt[j];
    }
    clipped0 /= n;
    crushed0 /= n;
    const meanSat = sat / n;

    // How bright the subject should end up, for this kind of scene (sRGB, 0–1).
    const key = quantile(lumW, wSum, 0.5);
    const lights = quantile(lumU, n, 0.99);
    let target;
    const highKey = !hasFaces && key > 0.6 && meanSat < 0.15;
    if (hasFaces) {
      target = 0.55; // faces a little above mid-grey
    } else if (key < 0.15 && lights > 0.7) {
      target = clamp(key * 1.6, key, 0.28); // night, a stage, a candle: keep it dark, lift a little
    } else if (highKey) {
      target = clamp(key, 0.46, 0.85); // snow, a beach, a white wall: keep it bright
    } else {
      target = 0.46 + 0.3 * (key - 0.46); // towards mid-grey, keeping some of the scene's own mood
    }
    const allowClip = Math.max(0.003, clipped0 * 1.2);
    const allowCrush = Math.max(0.005, crushed0 * 1.2);

    const histW = new Float64Array(BINS);
    const histU = new Float64Array(BINS);
    /** Draws the copy with these settings (the shader's maths, without the tone curve) and scores it. */
    function cost(s) {
      histW.fill(0);
      histU.fill(0);
      const ex = Math.pow(2, s.exposure);
      const bp = (-0.12 * s.blacks) / 100;
      const wp = 1 - (0.12 * s.whites) / 100;
      const span = Math.max(wp - bp, 0.05);
      const sh = s.shadows / 100;
      const hl = s.highlights / 100;
      const con = s.contrast / 100;
      let clip = 0;
      let crush = 0;
      for (let j = 0; j < n; j++) {
        let r = (toSrgb(R[j] * ex) - bp) / span;
        let g = (toSrgb(G[j] * ex) - bp) / span;
        let b = (toSrgb(B[j] * ex) - bp) / span;
        const L = clamp(0.2126 * r + 0.7152 * g + 0.0722 * b, 0, 1);
        const L2 = clamp(L + 0.28 * sh * (1 - smoothstep(0, 0.55, L)) + 0.28 * hl * smoothstep(0.45, 1, L), 0, 1.2);
        const k = L2 / Math.max(L, 1e-3);
        r = clamp(r * k, 0, 1);
        g = clamp(g * k, 0, 1);
        b = clamp(b * k, 0, 1);
        if (con >= 0) {
          r += (r * r * (3 - 2 * r) - r) * con;
          g += (g * g * (3 - 2 * g) - g) * con;
          b += (b * b * (3 - 2 * b) - b) * con;
        } else {
          r += (0.5 + (r - 0.5) * 0.4 - r) * -con;
          g += (0.5 + (g - 0.5) * 0.4 - g) * -con;
          b += (0.5 + (b - 0.5) * 0.4 - b) * -con;
        }
        const out = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (Math.max(r, g, b) >= 0.995) clip++;
        if (out <= 0.012) crush++;
        const bin = Math.min(BINS - 1, Math.floor(out * BINS));
        histW[bin] += wt[j];
        histU[bin]++;
      }
      clip /= n;
      crush /= n;
      const mid = quantile(histW, wSum, 0.5);
      const top = quantile(histU, n, 0.995);
      const bottom = quantile(histU, n, 0.005);
      const spread = quantile(histU, n, 0.9) - quantile(histU, n, 0.1);
      let c = 40 * (mid - target) ** 2;
      c += 8 * Math.max(0, clip - allowClip) + 6 * Math.max(0, crush - allowCrush);
      c += 4 * Math.max(0, 0.93 - top) ** 2 + (highKey ? 0 : 2 * Math.max(0, bottom - 0.04) ** 2);
      c += Math.max(0, 0.35 - spread) ** 2 + Math.max(0, spread - 0.8) ** 2;
      // Prefer small changes: a slider is only moved when it earns it.
      c += 3e-5 * (Math.abs(s.exposure) * 50 + Math.abs(s.contrast) + Math.abs(s.highlights) + Math.abs(s.shadows) + Math.abs(s.whites) + Math.abs(s.blacks));
      return c;
    }

    // Search one slider at a time, in shrinking steps, from a starting exposure that puts the
    // subject on target.
    const PARAMS = [
      { id: 'exposure', step: 0.25, min: 0.05, lo: -2.5, hi: 2.5 },
      { id: 'highlights', step: 20, min: 2, lo: -100, hi: 0 },
      { id: 'shadows', step: 20, min: 2, lo: -20, hi: 100 },
      { id: 'whites', step: 20, min: 2, lo: -60, hi: 60 },
      { id: 'blacks', step: 20, min: 2, lo: -60, hi: 60 },
      { id: 'contrast', step: 10, min: 2, lo: -30, hi: 35 },
    ];
    const keyLin = Math.max(1e-4, Math.pow((Math.max(key, 0.01) + 0.055) / 1.055, 2.4));
    const targetLin = Math.pow((target + 0.055) / 1.055, 2.4);
    const s = { exposure: clamp(Math.round(Math.log2(targetLin / keyLin) * 20) / 20, -2.5, 2.5), contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };
    let best = cost(s);
    for (let round = 0; round < 8; round++) {
      let moved = false;
      for (const p of PARAMS) {
        for (const dir of [1, -1]) {
          for (let k = 0; k < 6; k++) {
            const v = clamp(s[p.id] + dir * p.step, p.lo, p.hi);
            if (v === s[p.id]) break;
            const old = s[p.id];
            s[p.id] = v;
            const c = cost(s);
            if (c < best - 1e-7) {
              best = c;
              moved = true;
            } else {
              s[p.id] = old;
              break;
            }
          }
        }
      }
      if (!moved) {
        let any = false;
        for (const p of PARAMS) {
          if (p.step > p.min) {
            p.step = Math.max(p.min, p.step / 2);
            any = true;
          }
        }
        if (!any) break;
      }
    }

    // Vibrance for muted colours (less with people: skin goes orange quickly; none for black and white).
    const vibrance = meanSat < 0.03 ? 0 : Math.round(clamp((0.3 - meanSat) * 80, 0, hasFaces ? 10 : 20));

    return {
      ...clone(current),
      exposure: Math.round(s.exposure * 20) / 20,
      contrast: Math.round(s.contrast),
      highlights: Math.round(s.highlights),
      shadows: Math.round(s.shadows),
      whites: Math.round(s.whites),
      blacks: Math.round(s.blacks),
      temp: wb.temp,
      kelvin: 0,
      kelvinRef: 0,
      tint: wb.tint,
      vibrance,
    };
  }

  /**
   * Your own corrections (Settings › Polaroica › Auto Adjust) added on top of what Auto set, each
   * kept within its slider's range. `temperature` is added to Temp (−100…100).
   */
  function withTweaks(e, tweaks) {
    if (!tweaks) return e;
    const out = clone(e);
    for (const s of SLIDERS) {
      if (s.group === 'hidden' || !tweaks[s.id]) continue;
      const v = clamp(out[s.id] + tweaks[s.id], s.min, s.max);
      out[s.id] = s.id === 'exposure' ? Math.round(v * 20) / 20 : Math.round(v);
    }
    if (tweaks.temperature) out.temp = Math.round(clamp(out.temp + tweaks.temperature, -100, 100));
    return out;
  }

  function clone(e) {
    return JSON.parse(JSON.stringify(e));
  }

  function isDefault(e) {
    const idCurve = (c) => c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 255 && c[1][1] === 255;
    return SLIDERS.every((s) => s.id === 'colorHue' || !e[s.id]) && !hasKelvin(e) && CHANNELS.every((k) => idCurve(e.curves[k]));
  }

  function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // ---- tone curve maths ---------------------------------------------------------------

  /** Monotone cubic (Fritsch–Carlson) through the points: a smooth curve with no overshoot. */
  function curveTable(points) {
    const pts = points.slice().sort((a, b) => a[0] - b[0]);
    const n = pts.length;
    const out = new Float32Array(256);
    if (n < 2) {
      for (let i = 0; i < 256; i++) out[i] = i / 255;
      return out;
    }
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const d = [];
    const m = new Array(n).fill(0);
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
      let y;
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

  /** 256×1 RGBA table: per channel, the channel curve applied after the RGB curve. */
  function lutBytes(curves) {
    const master = curveTable(curves.rgb);
    const ch = [curveTable(curves.r), curveTable(curves.g), curveTable(curves.b)];
    const out = new Uint8Array(256 * 4);
    for (let x = 0; x < 256; x++) {
      const v = Math.round(master[x] * 255);
      out[x * 4] = Math.round(ch[0][v] * 255);
      out[x * 4 + 1] = Math.round(ch[1][v] * 255);
      out[x * 4 + 2] = Math.round(ch[2][v] * 255);
      out[x * 4 + 3] = 255;
    }
    return out;
  }

  // ---- Clarity / Dehaze maps (same as toneMaps() in src/core/develop.ts) -------------------

  const MAP_SIDE = 384;
  const LOG_EPS = 1 / 1024;

  function gaussBlur(src, w, hh, sigma) {
    const r = Math.ceil(sigma * 3);
    const k = new Float32Array(2 * r + 1);
    let ks = 0;
    for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    for (let i = 0; i < k.length; i++) k[i] /= ks;
    const tmp = new Float32Array(w * hh);
    const out = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += k[i + r] * src[y * w + clamp(x + i, 0, w - 1)];
        tmp[y * w + x] = a;
      }
    }
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0;
        for (let i = -r; i <= r; i++) a += k[i + r] * tmp[clamp(y + i, 0, hh - 1) * w + x];
        out[y * w + x] = a;
      }
    }
    return out;
  }

  function minFilter(src, w, hh, r) {
    const tmp = new Float32Array(w * hh);
    const out = new Float32Array(w * hh);
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        let m = Infinity;
        for (let i = -r; i <= r; i++) m = Math.min(m, src[y * w + clamp(x + i, 0, w - 1)]);
        tmp[y * w + x] = m;
      }
    }
    for (let y = 0; y < hh; y++) {
      for (let x = 0; x < w; x++) {
        let m = Infinity;
        for (let i = -r; i <= r; i++) m = Math.min(m, tmp[clamp(y + i, 0, hh - 1) * w + x]);
        out[y * w + x] = m;
      }
    }
    return out;
  }

  /**
   * What Clarity and Dehaze need, once per photo, from a small copy: the blurred log2 luminance
   * (`base`), how much of the scene shows through the haze (`trans`, dark channel prior) and the
   * haze's colour (`air`, linear).
   */
  function toneMaps(bitmap) {
    const s = Math.min(1, MAP_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * s));
    const hh = Math.max(1, Math.round(bitmap.height * s));
    const ctx = new OffscreenCanvas(w, hh).getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, hh);
    const d = ctx.getImageData(0, 0, w, hh).data;
    const n = w * hh;
    const R = new Float32Array(n);
    const G = new Float32Array(n);
    const B = new Float32Array(n);
    const logY = new Float32Array(n);
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = LIN[d[i * 4]];
      G[i] = LIN[d[i * 4 + 1]];
      B[i] = LIN[d[i * 4 + 2]];
      logY[i] = Math.log2(0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i] + LOG_EPS);
      m[i] = Math.min(R[i], G[i], B[i]);
    }
    const base = gaussBlur(logY, w, hh, 3);
    const dark = minFilter(m, w, hh, 2);
    const sorted = Float32Array.from(dark).sort();
    const cut = sorted[n - Math.max(1, Math.floor(n * 0.001))];
    const air = [0, 0, 0];
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
    const dn = minFilter(m, w, hh, 2);
    for (let i = 0; i < n; i++) dn[i] = 1 - 0.95 * dn[i];
    const trans = gaussBlur(dn, w, hh, 1.5);
    const rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      rgba[i * 4] = base[i];
      rgba[i * 4 + 1] = clamp(trans[i], 0, 1);
      rgba[i * 4 + 3] = 1;
    }
    return { width: w, height: hh, rgba, air };
  }

  /** The Color tint's colour at full strength (hue 0–359). */
  function tintColor(hue) {
    const x = (((hue % 360) + 360) % 360) / 360;
    return [clamp(Math.abs(x * 6 - 3) - 1, 0, 1), clamp(2 - Math.abs(x * 6 - 2), 0, 1), clamp(2 - Math.abs(x * 6 - 4), 0, 1)];
  }

  // ---- WebGL renderer -------------------------------------------------------------------

  const VERT = `#version 300 es
in vec2 p;
out vec2 v_uv;
void main() {
  v_uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

  const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_img;
uniform sampler2D u_lut;
uniform sampler2D u_maps; // r: blurred log2 luminance, g: haze transmission
uniform float u_exp, u_con, u_hi, u_sh, u_wh, u_bl, u_vib, u_sat;
uniform float u_cla, u_dhz, u_shp, u_nr, u_moire, u_fringe, u_tamt;
uniform vec3 u_wb, u_air, u_tint;
uniform vec2 u_texel;
uniform int u_bypass, u_detail;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float curve(float x, int ch) {
  vec4 t = texture(u_lut, vec2(clamp(x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}
// Sharpness, Noise, Moiré and Defringe from the 5x5 neighbourhood (detailStage() in develop.ts).
vec3 detail(vec2 uv, vec3 c) {
  float yc = luma(c);
  float sr = 0.02 + 0.1 * u_nr;
  vec3 sg = vec3(0.0), sb = vec3(0.0);
  float wg = 0.0, wb = 0.0, ymin = yc, ymax = yc;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec3 q = texture(u_img, uv + vec2(float(i), float(j)) * u_texel).rgb;
      float d2 = float(i * i + j * j);
      float yq = luma(q);
      float w1 = exp(-d2 / 2.0);
      sg += q * w1; wg += w1;
      float w2 = exp(-d2 / 4.5) * exp(-(yq - yc) * (yq - yc) / (2.0 * sr * sr));
      sb += q * w2; wb += w2;
      ymin = min(ymin, yq); ymax = max(ymax, yq);
    }
  }
  vec3 G = sg / wg;
  vec3 r = u_nr > 0.0 ? mix(c, sb / wb, u_nr) : c;
  if (u_moire > 0.0) {
    vec3 sm = vec3(0.0);
    float wm = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        vec3 q = texture(u_img, uv + vec2(float(i), float(j)) * 2.0 * u_texel).rgb;
        float w1 = exp(-float(i * i + j * j) / 2.0);
        sm += (q - luma(q)) * w1; wm += w1;
      }
    }
    float l = luma(r);
    r = l + mix(r - l, sm / wm, u_moire);
  }
  if (u_fringe > 0.0) {
    float edge = smoothstep(0.1, 0.35, ymax - ymin);
    float purple = smoothstep(0.02, 0.1, min(r.r - r.g, r.b - r.g));
    float green = smoothstep(0.02, 0.1, min(r.g - r.r, r.g - r.b));
    r = mix(r, vec3(luma(r)), u_fringe * edge * max(purple, green));
  }
  if (u_shp > 0.0) r += (yc - luma(G)) * u_shp * 1.5;
  else if (u_shp < 0.0) r = mix(r, G, -u_shp);
  return clamp(r, 0.0, 1.0);
}
// The Color tint: its hue at this brightness (W3C ClipColor keeps it in range).
vec3 tinted(vec3 g) {
  vec3 c = u_tint + (luma(g) - luma(u_tint));
  float l = luma(c), n = min(c.r, min(c.g, c.b)), x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return mix(g, c, u_tamt);
}
void main() {
  vec4 s = texture(u_img, v_uv);
  if (u_bypass == 1) { o = s; return; }
  vec3 src = u_detail == 1 ? detail(v_uv, s.rgb) : s.rgb;
  vec3 c = toLin(src);
  // Clarity: how far this pixel stands out from the large shapes around it (log2 luminance).
  vec4 mp = texture(u_maps, v_uv);
  float dd = clamp(log2(luma(c) + 0.0009765625) - mp.r, -2.0, 2.0);
  // Dehaze (dark channel prior): take out the haze, or lay more of it on.
  if (u_dhz > 0.0) c = max((c - u_air) / max(1.0 - u_dhz * (1.0 - mp.g), 0.2) + u_air, 0.0);
  else if (u_dhz < 0.0) c = mix(c, u_air, -u_dhz * 0.5);
  // Exposure and white balance in linear light.
  c *= exp2(u_exp);
  c *= u_wb;
  if (u_cla != 0.0) {
    float lm = clamp(toSrgb(vec3(luma(c))).r, 0.0, 1.0);
    c *= exp2(clamp(u_cla * 0.8 * dd * 4.0 * lm * (1.0 - lm), -1.5, 1.5));
  }
  vec3 g = toSrgb(c);
  // Whites / blacks move the end points.
  float bp = -0.12 * u_bl;
  float wp = 1.0 - 0.12 * u_wh;
  g = (g - bp) / max(wp - bp, 0.05);
  // Shadows / highlights: brightness changes masked to the dark / bright tones.
  float L = clamp(luma(g), 0.0, 1.0);
  float ms = 1.0 - smoothstep(0.0, 0.55, L);
  float mh = smoothstep(0.45, 1.0, L);
  float L2 = clamp(L + 0.28 * u_sh * ms + 0.28 * u_hi * mh, 0.0, 1.2);
  g *= L2 / max(L, 1e-3);
  // Contrast: an S-curve (or flattening) around mid-grey.
  g = clamp(g, 0.0, 1.0);
  g = u_con >= 0.0 ? mix(g, g * g * (3.0 - 2.0 * g), u_con) : mix(g, 0.5 + (g - 0.5) * 0.4, -u_con);
  // Tone curve.
  g = vec3(curve(g.r, 0), curve(g.g, 1), curve(g.b, 2));
  // Vibrance (boosts muted colours more) and saturation.
  float l = luma(g);
  float sat = max(g.r, max(g.g, g.b)) - min(g.r, min(g.g, g.b));
  float k = 1.0 + u_sat + u_vib * (1.0 - sat);
  g = clamp(l + (g - l) * max(k, 0.0), 0.0, 1.0);
  if (u_tamt > 0.0) g = tinted(g);
  o = vec4(clamp(g, 0.0, 1.0), s.a);
}`;

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false });
      if (!gl) {
        throw new Error('WebGL2 is not available');
      }
      this.gl = gl;
      const prog = gl.createProgram();
      for (const [type, src] of [
        [gl.VERTEX_SHADER, VERT],
        [gl.FRAGMENT_SHADER, FRAG],
      ]) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(sh));
        }
        gl.attachShader(prog, sh);
      }
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog));
      }
      this.prog = prog;
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const n of ['u_img', 'u_lut', 'u_maps', 'u_exp', 'u_con', 'u_hi', 'u_sh', 'u_wh', 'u_bl', 'u_wb', 'u_vib', 'u_sat', 'u_bypass', 'u_cla', 'u_dhz', 'u_shp', 'u_nr', 'u_moire', 'u_fringe', 'u_tamt', 'u_air', 'u_tint', 'u_texel', 'u_detail']) {
        this.u[n] = gl.getUniformLocation(prog, n);
      }
      this.imgTex = this.texture(0);
      this.lutTex = this.texture(1);
      this.mapTex = this.texture(3); // unit 2 is the histogram's render target
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array([0, 1, 0, 1]));
      gl.uniform1i(this.u.u_img, 0);
      gl.uniform1i(this.u.u_lut, 1);
      gl.uniform1i(this.u.u_maps, 3);
      gl.uniform3fv(this.u.u_air, [1, 1, 1]);
      this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      this.width = 0;
      this.height = 0;
      this.bypass = false;
      this.setEdits(defaults());
    }

    texture(unit) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    /** ImageBitmap (already upright). Larger than the GPU allows: shrunk first. */
    async setImage(bitmap) {
      const gl = this.gl;
      let src = bitmap;
      const big = Math.max(bitmap.width, bitmap.height);
      if (big > this.maxSize) {
        const s = this.maxSize / big;
        src = await createImageBitmap(bitmap, { resizeWidth: Math.floor(bitmap.width * s), resizeHeight: Math.floor(bitmap.height * s), resizeQuality: 'high' });
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.imgTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      this.width = src.width;
      this.height = src.height;
      this.sample = samplePixels(src);
      const maps = toneMaps(src);
      gl.useProgram(this.prog);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, maps.width, maps.height, 0, gl.RGBA, gl.FLOAT, maps.rgba);
      gl.uniform3fv(this.u.u_air, maps.air);
      gl.uniform2f(this.u.u_texel, 1 / src.width, 1 / src.height);
      if (src !== bitmap) src.close();
    }

    setEdits(e) {
      const gl = this.gl;
      gl.useProgram(this.prog);
      gl.uniform1f(this.u.u_exp, e.exposure);
      gl.uniform1f(this.u.u_con, e.contrast / 100);
      gl.uniform1f(this.u.u_hi, e.highlights / 100);
      gl.uniform1f(this.u.u_sh, e.shadows / 100);
      gl.uniform1f(this.u.u_wh, e.whites / 100);
      gl.uniform1f(this.u.u_bl, e.blacks / 100);
      gl.uniform3fv(this.u.u_wb, wbGains(e));
      gl.uniform1f(this.u.u_vib, e.vibrance / 100);
      gl.uniform1f(this.u.u_sat, e.saturation / 100);
      gl.uniform1f(this.u.u_cla, (e.clarity || 0) / 100);
      gl.uniform1f(this.u.u_dhz, (e.dehaze || 0) / 100);
      gl.uniform1f(this.u.u_shp, (e.sharpness || 0) / 100);
      gl.uniform1f(this.u.u_nr, (e.noise || 0) / 100);
      gl.uniform1f(this.u.u_moire, (e.moire || 0) / 100);
      gl.uniform1f(this.u.u_fringe, (e.defringe || 0) / 100);
      gl.uniform1i(this.u.u_detail, e.sharpness || e.noise || e.moire || e.defringe ? 1 : 0);
      gl.uniform1f(this.u.u_tamt, ((e.colorAmount || 0) / 100) * 0.6);
      gl.uniform3fv(this.u.u_tint, tintColor(e.colorHue || 0));
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lutBytes(e.curves));
    }

    /** Draws into the canvas at its current pixel size. */
    draw() {
      const gl = this.gl;
      gl.uniform1i(this.u.u_bypass, this.bypass ? 1 : 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    /** Histogram of the edited image (from a small render): {r, g, b, l}, 128 bins each. */
    histogram() {
      const gl = this.gl;
      if (!this.width) {
        return undefined;
      }
      const s = 256 / Math.max(this.width, this.height);
      const w = Math.max(1, Math.round(this.width * s));
      const hh = Math.max(1, Math.round(this.height * s));
      if (!this.fbo || this.fboW !== w || this.fboH !== hh) {
        this.fbo = gl.createFramebuffer();
        this.fboTex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, hh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
        this.fboW = w;
        this.fboH = hh;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, w, hh);
      gl.uniform1i(this.u.u_bypass, this.bypass ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const px = new Uint8Array(w * hh * 4);
      gl.readPixels(0, 0, w, hh, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const bins = () => new Uint32Array(128);
      const hist = { r: bins(), g: bins(), b: bins(), l: bins() };
      for (let i = 0; i < px.length; i += 4) {
        hist.r[px[i] >> 1]++;
        hist.g[px[i + 1] >> 1]++;
        hist.b[px[i + 2] >> 1]++;
        hist.l[Math.round(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) >> 1]++;
      }
      return hist;
    }
  }

  // ---- panel UI ---------------------------------------------------------------------------

  /**
   * The ADJUST panel. `onChange(edits, commit)`: commit=false while dragging, true when a
   * change is finished (for undo and saving).
   */
  function createPanel(opts) {
    let edits = defaults();
    const rows = {};

    const histCanvas = h('canvas', { class: 'histogram', width: '256', height: '80', role: 'img', 'aria-label': 'Histogram' });

    const sliderRow = (s) => {
      const value = h('span', { class: 'adj-value' });
      const input = h('input', {
        type: 'range',
        id: 'adj-' + s.id,
        min: String(s.min),
        max: String(s.max),
        step: String(s.step),
        'aria-label': s.label,
        title: (s.title ? s.title + ' · ' : '') + 'Double-click to reset',
        oninput: (e) => {
          edits = { ...edits, [s.id]: Number(e.target.value) };
          paintValue(s, value, edits[s.id]);
          if (s.group === 'tint') paintTint();
          opts.onChange(clone(edits), false);
        },
        onchange: () => opts.onChange(clone(edits), true),
        ondblclick: () => {
          edits = { ...edits, [s.id]: 0 };
          set(edits);
          opts.onChange(clone(edits), true);
        },
      });
      if (s.track) {
        input.style.setProperty('--track', s.track);
      }
      rows[s.id] = { input, value, spec: s };
      return h('div', { class: 'adj-row' }, h('label', { for: 'adj-' + s.id }, s.label), input, value);
    };

    const paintValue = (s, el, v) => {
      if (s.id === 'colorHue') {
        el.textContent = `${Math.round(v)}°`;
        el.classList.toggle('zero', !edits.colorAmount);
        return;
      }
      el.textContent = (v > 0 && s.min < 0 ? '+' : '') + (s.id === 'exposure' ? Number(v).toFixed(2) : String(Math.round(v)));
      el.classList.toggle('zero', !v);
    };
    /** The Strength track fades into the chosen colour; the hue reads as off while Strength is 0. */
    const paintTint = () => {
      const c = tintColor(edits.colorHue || 0).map((v) => Math.round(v * 255));
      if (rows.colorAmount) rows.colorAmount.input.style.setProperty('--track', `linear-gradient(90deg, #7a7a7a, rgb(${c.join(',')}))`);
      if (rows.colorHue) paintValue(rows.colorHue.spec, rows.colorHue.value, edits.colorHue);
    };

    // The photo's own temperature (as shot for RAW, estimated for JPEG): what Auto balances from.
    let ref; // { kelvin, source: 'camera' | 'estimated' }
    /** A Kelvin white balance (older edits, or pasted from one) becomes the relative Temp. */
    function adopt() {
      if (!hasKelvin(edits)) return false;
      const t = clamp((edits.temp || 0) + tempOfKelvin(edits.kelvinRef, edits.kelvin), -100, 100);
      edits = { ...edits, temp: t, kelvin: 0, kelvinRef: 0 };
      return true;
    }

    const iconBtn = (name, label, title, onclick) => h('button', { class: 'icon-btn', 'aria-label': label, title, onclick }, icon(name));
    const autoBtn = iconBtn('wand', 'Auto', 'Auto: set Light and Color for a balanced picture (you can fine-tune or undo it). Settings › Polaroica › Auto Adjust adds your own corrections on top.', () => {
      const c = opts.autoContext && opts.autoContext();
      if (!c || !c.sample) return;
      edits = withTweaks(autoEdits(c.sample, ref ? ref.kelvin : 0, edits, c), c.tweaks);
      set(edits);
      opts.onChange(clone(edits), true);
    });
    const pasteBtn = iconBtn('paste', 'Paste Settings', 'Paste settings', () => opts.onPaste());
    const el = h(
      'div',
      { class: 'adjust' },
      h(
        'div',
        { class: 'adj-block' },
        h(
          'div',
          { class: 'adj-actions', role: 'toolbar', 'aria-label': 'Adjust actions' },
          autoBtn,
          h('span', { class: 'sep', 'aria-hidden': 'true' }),
          iconBtn('reset', 'Reset', 'Reset all adjustments', () => {
            edits = defaults();
            set(edits);
            opts.onChange(clone(edits), true);
          }),
          iconBtn('copy', 'Copy Settings', 'Copy settings', () => opts.onCopy(clone(edits))),
          pasteBtn,
        ),
      ),
      h('div', { class: 'adj-block' }, histCanvas),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'LIGHT'), ...SLIDERS.filter((s) => s.group === 'light').map(sliderRow)),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'COLOR'), ...SLIDERS.filter((s) => s.group === 'color' || s.group === 'tint').map(sliderRow)),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'PRESENCE'), ...SLIDERS.filter((s) => s.group === 'presence').map(sliderRow)),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'DETAIL'), ...SLIDERS.filter((s) => s.group === 'detail').map(sliderRow)),
    );

    function set(e) {
      edits = clone(e);
      const converted = adopt();
      for (const id of Object.keys(rows)) {
        rows[id].input.value = String(edits[id]);
        paintValue(rows[id].spec, rows[id].value, edits[id]);
      }
      paintTint();
      if (converted) opts.onChange(clone(edits), false);
    }

    /** The photo's own temperature ({ kelvin, source }), or undefined while it is not known yet. */
    function setReference(r) {
      ref = r && r.kelvin > 0 ? { kelvin: roundKelvin(r.kelvin), source: r.source } : undefined;
    }

    function drawHistogram(hist) {
      const ctx = histCanvas.getContext('2d');
      ctx.clearRect(0, 0, 256, 80);
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, 256, 80);
      if (!hist) {
        return;
      }
      // Ignore the extreme bins when scaling, so clipped shadows/highlights don't flatten the rest.
      let max = 1;
      for (const k of ['r', 'g', 'b']) {
        for (let i = 1; i < 127; i++) max = Math.max(max, hist[k][i]);
      }
      ctx.globalCompositeOperation = 'lighter';
      const fills = { r: 'rgba(230,80,80,0.55)', g: 'rgba(80,200,100,0.5)', b: 'rgba(80,130,240,0.55)' };
      for (const k of ['r', 'g', 'b']) {
        ctx.fillStyle = fills[k];
        ctx.beginPath();
        ctx.moveTo(0, 80);
        for (let i = 0; i < 128; i++) {
          ctx.lineTo(i * 2, 80 - Math.min(1, hist[k][i] / max) * 76);
          ctx.lineTo(i * 2 + 2, 80 - Math.min(1, hist[k][i] / max) * 76);
        }
        ctx.lineTo(256, 80);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    set(edits);
    drawHistogram(undefined);
    autoBtn.disabled = true;
    return {
      el,
      set,
      setReference,
      drawHistogram,
      setCanPaste(on) {
        pasteBtn.disabled = !on;
      },
      /** Auto needs the photo's pixels: off until they are loaded. */
      setCanAuto(on) {
        autoBtn.disabled = !on;
      },
    };
  }

  window.polaroicaAdjust = { defaults, clone, isDefault, same, createPanel, Renderer, curveTable, estimateKelvin, autoEdits, withTweaks };
})();
