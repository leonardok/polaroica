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
    // Older edits' relative temperature: still applied, but the panel shows Kelvin instead.
    { id: 'temp', label: 'Temperature', min: -100, max: 100, step: 1, group: 'hidden' },
    { id: 'tint', label: 'Tint', min: -100, max: 100, step: 1, group: 'color', track: 'linear-gradient(90deg, #5cb85c, #c562c5)' },
    { id: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, group: 'color' },
    { id: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, group: 'color', track: 'linear-gradient(90deg, #7a7a7a, #d9534f)' },
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
  /** Kelvin that gives the same red / blue shift as an older edit's relative Temperature. */
  function kelvinForLegacy(ref, temp) {
    const want = Math.log((1 + 0.25 * temp / 100) / (1 - 0.25 * temp / 100));
    let best = ref;
    let err = Infinity;
    for (let m = 1e6 / KELVIN_MAX; m <= 1e6 / KELVIN_MIN; m += 0.5) {
      const g = kelvinGains(ref, 1e6 / m);
      const d = Math.abs(Math.log(g[0] / g[2]) - want);
      if (d < err) {
        err = d;
        best = 1e6 / m;
      }
    }
    return roundKelvin(best);
  }

  function clone(e) {
    return JSON.parse(JSON.stringify(e));
  }

  function isDefault(e) {
    const idCurve = (c) => c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 255 && c[1][1] === 255;
    return SLIDERS.every((s) => !e[s.id]) && !hasKelvin(e) && CHANNELS.every((k) => idCurve(e.curves[k]));
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
uniform float u_exp, u_con, u_hi, u_sh, u_wh, u_bl, u_vib, u_sat;
uniform vec3 u_wb;
uniform int u_bypass;
vec3 toLin(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float curve(float x, int ch) {
  vec4 t = texture(u_lut, vec2(clamp(x, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  return ch == 0 ? t.r : (ch == 1 ? t.g : t.b);
}
void main() {
  vec4 s = texture(u_img, v_uv);
  if (u_bypass == 1) { o = s; return; }
  // Exposure and white balance in linear light.
  vec3 c = toLin(s.rgb) * exp2(u_exp);
  c *= u_wb;
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
  g = l + (g - l) * max(k, 0.0);
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
      for (const n of ['u_img', 'u_lut', 'u_exp', 'u_con', 'u_hi', 'u_sh', 'u_wh', 'u_bl', 'u_wb', 'u_vib', 'u_sat', 'u_bypass']) {
        this.u[n] = gl.getUniformLocation(prog, n);
      }
      this.imgTex = this.texture(0);
      this.lutTex = this.texture(1);
      gl.uniform1i(this.u.u_img, 0);
      gl.uniform1i(this.u.u_lut, 1);
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
        title: 'Double-click to reset',
        oninput: (e) => {
          edits = { ...edits, [s.id]: Number(e.target.value) };
          paintValue(s, value, edits[s.id]);
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
      el.textContent = (v > 0 ? '+' : '') + (s.id === 'exposure' ? Number(v).toFixed(2) : String(Math.round(v)));
      el.classList.toggle('zero', !v);
    };

    // Temperature in Kelvin, from the photo's own: as shot (RAW) or estimated (JPEG). The slider
    // moves in even steps of mired (1e6 / K), as the eye sees warmth change.
    let ref; // { kelvin, source: 'camera' | 'estimated' }
    const kValue = h('span', { class: 'adj-value' });
    const kInput = h('input', {
      type: 'range',
      id: 'adj-kelvin',
      min: String(-1e6 / KELVIN_MIN),
      max: String(-1e6 / KELVIN_MAX),
      step: '0.1',
      'aria-label': 'Temperature (Kelvin)',
      oninput: (e) => {
        if (!ref) return;
        const k = roundKelvin(-1e6 / Number(e.target.value));
        edits = k === ref.kelvin ? { ...edits, kelvin: 0, kelvinRef: 0 } : { ...edits, kelvin: k, kelvinRef: ref.kelvin };
        paintKelvin(false);
        opts.onChange(clone(edits), false);
      },
      onchange: () => opts.onChange(clone(edits), true),
      ondblclick: () => {
        edits = { ...edits, kelvin: 0, kelvinRef: 0, temp: 0 };
        paintKelvin(true);
        opts.onChange(clone(edits), true);
      },
    });
    kInput.style.setProperty('--track', 'linear-gradient(90deg, #4a7fd1, #e8e8e8 45%, #d9a54a)');
    const kRow = h('div', { class: 'adj-row' }, h('label', { for: 'adj-kelvin', title: 'Temperature (white balance)' }, 'Temp'), kInput, kValue);
    const fmtK = (k) => `${k.toLocaleString('en-US')} K`;
    function paintKelvin(moveThumb) {
      const k = hasKelvin(edits) ? edits.kelvin : ref ? ref.kelvin : 0;
      kInput.disabled = !ref;
      if (moveThumb && k) kInput.value = String(-1e6 / k);
      kValue.textContent = k ? (ref && ref.source === 'estimated' && !hasKelvin(edits) ? '≈' : '') + fmtK(k) : '—';
      kValue.classList.toggle('zero', !hasKelvin(edits));
      const own = ref ? (ref.source === 'camera' ? `As shot: ${fmtK(ref.kelvin)}` : `Estimated from the picture: ${fmtK(ref.kelvin)}`) : 'Reading the photo’s white balance…';
      const title = `${own} · lower is cooler, higher is warmer · double-click for ${ref && ref.source === 'camera' ? 'as shot' : 'the photo’s own'}`;
      kInput.title = title;
      kValue.title = title;
    }
    /** Edits made elsewhere, put in terms of this photo's own temperature. */
    function adopt() {
      if (!ref) return false;
      if (edits.temp) {
        // An older relative Temperature: the Kelvin value that warms or cools the same amount.
        const k = kelvinForLegacy(ref.kelvin, edits.temp);
        edits = { ...edits, temp: 0, kelvin: k === ref.kelvin ? 0 : k, kelvinRef: k === ref.kelvin ? 0 : ref.kelvin };
        return true;
      }
      if (hasKelvin(edits) && edits.kelvinRef !== ref.kelvin) {
        // Pasted from another photo, or the estimate moved: keep the Kelvin value, re-base it.
        edits = edits.kelvin === ref.kelvin ? { ...edits, kelvin: 0, kelvinRef: 0 } : { ...edits, kelvinRef: ref.kelvin };
        return true;
      }
      return false;
    }

    const pasteBtn = h('button', { class: 'btn', onclick: () => opts.onPaste() }, 'Paste');
    const el = h(
      'div',
      { class: 'adjust' },
      h('div', { class: 'adj-block' }, histCanvas),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'LIGHT'), ...SLIDERS.filter((s) => s.group === 'light').map(sliderRow)),
      h('div', { class: 'adj-block' }, h('div', { class: 'adj-title' }, 'COLOR'), kRow, ...SLIDERS.filter((s) => s.group === 'color').map(sliderRow)),
      h(
        'div',
        { class: 'adj-block' },
        h(
          'div',
          { class: 'actions' },
          h('button', {
            class: 'btn',
            onclick: () => {
              edits = defaults();
              set(edits);
              opts.onChange(clone(edits), true);
            },
          }, 'Reset'),
          h('button', { class: 'btn', onclick: () => opts.onCopy(clone(edits)) }, 'Copy Settings'),
          pasteBtn,
        ),
        h('p', { class: 'hint-small' }, opts.note),
      ),
    );

    function set(e) {
      edits = clone(e);
      for (const id of Object.keys(rows)) {
        rows[id].input.value = String(edits[id]);
        paintValue(rows[id].spec, rows[id].value, edits[id]);
      }
      if (adopt()) opts.onChange(clone(edits), false);
      paintKelvin(true);
    }

    /** The photo's own temperature ({ kelvin, source }), or undefined while it is not known yet. */
    function setReference(r) {
      ref = r && r.kelvin > 0 ? { kelvin: roundKelvin(r.kelvin), source: r.source } : undefined;
      if (adopt()) opts.onChange(clone(edits), false);
      paintKelvin(true);
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
    return {
      el,
      set,
      setReference,
      drawHistogram,
      setCanPaste(on) {
        pasteBtn.disabled = !on;
      },
    };
  }

  window.polaroicaAdjust = { defaults, clone, isDefault, same, createPanel, Renderer, curveTable, estimateKelvin };
})();
