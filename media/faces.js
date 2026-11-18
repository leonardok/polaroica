// Face expression scores for Auto-Rank. MediaPipe runs here, in the grid tab (it needs a
// browser), entirely on this computer. Two steps: a face detector finds every face, then Face
// Landmarker reads each face on its own crop (asked for several faces at once it misses some,
// reports some twice and mixes up their expressions). The extension sends a photo; this returns,
// per face, how open the eyes are, whether the person faces the camera, smiles, or was caught
// mid-word.
//
// Several photos are read at once, each by its own copy of the models on a worker thread of this
// page. If workers can't start, photos are read one at a time on the page itself.
(function () {
  /**
   * The face reader. Self-contained (no outside variables): the same source runs on the page and,
   * as text, inside each worker. `scope` is `window` or the worker's `self`.
   */
  function faceEngine(scope) {
    let models; // Promise<{ detector, landmarker }>

    async function loadLibrary(bundle) {
      if (scope.Vision) return;
      if (typeof scope.importScripts === 'function') {
        scope.importScripts(bundle);
        return;
      }
      // The plain-script build (global `Vision`): a module (.mjs) import depends on the editor
      // serving the right MIME type for .mjs, which not every VS Code build does.
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = bundle;
        s.onload = resolve;
        s.onerror = () => reject(new Error('could not load the face library (' + bundle + ')'));
        document.head.append(s);
      });
    }

    function load(rt, bytes) {
      if (!models) {
        models = (async () => {
          await loadLibrary(rt.bundle);
          const { FilesetResolver, FaceLandmarker, FaceDetector } = scope.Vision;
          if (!bytes) throw new Error('the face models were not received');
          const fileset = await FilesetResolver.forVisionTasks(rt.wasm);
          // CPU: predictable in every editor (the GPU path can stall in a webview).
          const detector = await FaceDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: bytes.detector, delegate: 'CPU' },
            runningMode: 'IMAGE',
            minDetectionConfidence: 0.5,
          });
          const landmarker = await FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: bytes.landmarker, delegate: 'CPU' },
            runningMode: 'IMAGE',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
          });
          return { detector, landmarker };
        })();
        models.catch(() => (models = undefined));
      }
      return models;
    }

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    /** Scores 0–100 for one face from its blendshapes and head pose; `area` is its share of the photo. */
    function metric(shapes, matrix, area) {
      const b = {};
      for (const c of shapes.categories) b[c.categoryName] = c.score;
      const v = (k) => b[k] || 0;

      // Eyes: blinks above ~0.35 are often just a squint from smiling; 0.6+ means closed.
      const blink = Math.max(v('eyeBlinkLeft'), v('eyeBlinkRight'));
      const eyes = 100 * (1 - clamp01((blink - 0.35) / 0.25));

      const smile = 100 * ((v('mouthSmileLeft') + v('mouthSmileRight')) / 2);

      // Head turned (yaw) or tilted up/down (pitch), in degrees, from the face's transform.
      let looking = 100;
      if (matrix && matrix.data && matrix.data.length >= 16) {
        const m = matrix.data;
        const yaw = (Math.asin(Math.max(-1, Math.min(1, -m[2]))) * 180) / Math.PI;
        const pitch = (Math.atan2(m[6], m[10]) * 180) / Math.PI;
        looking = 100 * clamp01(1 - (Math.abs(yaw) / 35 + Math.abs(pitch) / 30));
      }
      // Eyes looking away from the lens even with the head straight.
      const gaze = Math.max(
        ...['eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookInLeft', 'eyeLookInRight', 'eyeLookUpLeft', 'eyeLookUpRight'].map(v),
        blink < 0.5 ? Math.max(v('eyeLookDownLeft'), v('eyeLookDownRight')) : 0,
      );
      looking *= 1 - 0.7 * clamp01((gaze - 0.3) / 0.4);

      // Natural: not mid-word (mouth open without a smile) and not frowning.
      const midWord = v('jawOpen') * (1 - smile / 100);
      const frown = (v('mouthFrownLeft') + v('mouthFrownRight')) / 2;
      const natural = 100 * (1 - clamp01(Math.max(midWord * 1.6, frown * 1.4)));

      const r = (n) => Math.round(n);
      return { area, eyes: r(eyes), looking: r(looking), smile: r(smile), natural: r(natural) };
    }

    /**
     * Focus inside a face box, 0–100, or undefined when the face is too small to judge. Re-blur
     * sharpness: how much edge contrast a 9-pixel box blur removes (a sharp face loses a lot).
     * Same algorithm and scale as reblurSharpness / faceFocusScore in src/core/analyze.ts.
     */
    function faceFocus(px, width, height, b) {
      const x0 = Math.max(0, Math.round(b.originX));
      const y0 = Math.max(0, Math.round(b.originY));
      const x1 = Math.min(width, Math.round(b.originX + b.width));
      const y1 = Math.min(height, Math.round(b.originY + b.height));
      const rw = x1 - x0;
      const rh = y1 - y0;
      if (rw < 64 || rh < 64) return undefined;
      const g = new Float32Array(rw * rh);
      for (let y = 0; y < rh; y++) {
        for (let x = 0; x < rw; x++) {
          const i = ((y0 + y) * width + x0 + x) * 4;
          g[y * rw + x] = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        }
      }
      const R = 4;
      let sIx = 0, sVx = 0, sIy = 0, sVy = 0;
      for (let y = 0; y < rh; y++) {
        const o = y * rw;
        let sum = 0;
        for (let k = -R; k <= R; k++) sum += g[o + Math.min(rw - 1, Math.max(0, k))];
        let prevI = g[o], prevB = sum / (2 * R + 1);
        for (let x = 1; x < rw; x++) {
          sum += g[o + Math.min(rw - 1, x + R)] - g[o + Math.max(0, x - R - 1)];
          const bl = sum / (2 * R + 1);
          const dI = Math.abs(g[o + x] - prevI);
          sIx += dI;
          sVx += Math.max(0, dI - Math.abs(bl - prevB));
          prevI = g[o + x];
          prevB = bl;
        }
      }
      for (let x = 0; x < rw; x++) {
        let sum = 0;
        for (let k = -R; k <= R; k++) sum += g[Math.min(rh - 1, Math.max(0, k)) * rw + x];
        let prevI = g[x], prevB = sum / (2 * R + 1);
        for (let y = 1; y < rh; y++) {
          sum += g[Math.min(rh - 1, y + R) * rw + x] - g[Math.max(0, y - R - 1) * rw + x];
          const bl = sum / (2 * R + 1);
          const dI = Math.abs(g[y * rw + x] - prevI);
          sIy += dI;
          sVy += Math.max(0, dI - Math.abs(bl - prevB));
          prevI = g[y * rw + x];
          prevB = bl;
        }
      }
      const blur = Math.max(sIx ? (sIx - sVx) / sIx : 1, sIy ? (sIy - sVy) / sIy : 1);
      const sharp = 1 - blur;
      return Math.round(Math.max(0, Math.min(100, ((sharp - 0.2) / 0.45) * 100)));
    }

    /** Faces in a photo: upright RGBA pixels (already shrunk by the extension). */
    async function detect(data, width, height, rt, bytes) {
      const { detector, landmarker } = await load(rt, bytes);
      const px = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
      const image = await createImageBitmap(new ImageData(px, width, height));
      try {
        const out = [];
        for (const d of detector.detect(image).detections) {
          const b = d.boundingBox;
          if (!b || b.width <= 0) continue;
          // A square around the face with room for hair and chin, shrunk to 512 px.
          const side = Math.max(b.width, b.height) * 2.2;
          const cx = b.originX + b.width / 2;
          const cy = b.originY + b.height / 2;
          const x = Math.max(0, cx - side / 2);
          const y = Math.max(0, cy - side / 2);
          const w = Math.min(width - x, side);
          const h = Math.min(height - y, side);
          if (w < 8 || h < 8) continue;
          const k = Math.min(1, 512 / Math.max(w, h));
          const crop = await createImageBitmap(image, x, y, w, h, { resizeWidth: Math.round(w * k), resizeHeight: Math.round(h * k), resizeQuality: 'high' });
          try {
            const r = landmarker.detect(crop);
            if (!r.faceLandmarks.length) continue;
            const area = Math.round(((b.width * b.height) / (width * height)) * 10000) / 10000;
            const m = metric(r.faceBlendshapes[0] || { categories: [] }, (r.facialTransformationMatrixes || [])[0], area);
            const f = faceFocus(px, width, height, b);
            if (f !== undefined) m.focus = f;
            const r4 = (v) => Math.round(v * 10000) / 10000;
            m.box = [r4(b.originX / width), r4(b.originY / height), r4(b.width / width), r4(b.height / height)];
            out.push(m);
          } finally {
            crop.close();
          }
        }
        return out;
      } finally {
        image.close();
      }
    }

    // One photo at a time per engine: a model isn't re-entrant.
    let queue = Promise.resolve();
    return {
      detect(data, width, height, rt, bytes) {
        const run = queue.then(() => detect(data, width, height, rt, bytes));
        queue = run.catch(() => undefined);
        return run;
      },
    };
  }

  /** Runs inside each worker. */
  function workerMain() {
    const engine = faceEngine(self);
    let rt, bytes;
    self.onmessage = async (e) => {
      const m = e.data;
      if (m.type === 'init') {
        rt = m.rt;
        bytes = m.bytes;
        return;
      }
      try {
        const faces = await engine.detect(m.data, m.width, m.height, rt, bytes);
        self.postMessage({ id: m.id, faces });
      } catch (err) {
        self.postMessage({ id: m.id, error: String((err && err.message) || err) });
      }
    };
  }

  /** Model files as bytes, sent once by the extension (kept so a failed load can be retried). */
  let modelBytes;
  let runtime;
  let workers; // [{ w, busy, jobs }] once started; null when workers can't be used
  let pageEngine;
  let nextId = 1;
  let workerWorked = false;
  const callbacks = new Map();

  function startWorkers() {
    if (workers !== undefined) return workers;
    try {
      // Each copy of the models takes ~100 MB; half the cores (2–6) leaves room for the rest.
      const n = Math.max(2, Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
      const src = faceEngine.toString() + '\n(' + workerMain.toString() + ')();';
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      workers = [];
      for (let i = 0; i < n; i++) {
        const w = new Worker(url);
        const slot = { w, jobs: 0 };
        w.onmessage = (e) => {
          slot.jobs--;
          const cb = callbacks.get(e.data.id);
          if (!cb) return;
          if (e.data.error && !workerWorked) {
            // Never worked in a worker (e.g. the library couldn't load there): use the page.
            fallBack(new Error(e.data.error));
            return;
          }
          callbacks.delete(e.data.id);
          if (e.data.error) cb.reject(new Error(e.data.error));
          else {
            workerWorked = true;
            cb.resolve(e.data.faces);
          }
        };
        w.onerror = (e) => {
          e.preventDefault();
          fallBack(new Error(e.message || 'face worker failed'));
        };
        w.postMessage({ type: 'init', rt: runtime, bytes: modelBytes });
        workers.push(slot);
      }
    } catch {
      workers = null;
    }
    return workers;
  }

  /** Workers broke (e.g. blocked by the page's security policy): finish on the page instead. */
  function fallBack(err) {
    if (!workers) return;
    for (const s of workers) s.w.terminate();
    workers = null;
    const pending = [...callbacks.values()];
    callbacks.clear();
    for (const cb of pending) onPage(cb.job).then(cb.resolve, cb.reject);
    void err;
  }

  function onPage(job) {
    pageEngine = pageEngine || faceEngine(window);
    return pageEngine.detect(job.data, job.width, job.height, runtime, modelBytes);
  }

  window.polaroica.faces = {
    detect: (data, width, height, rt, bytes) => {
      if (bytes) modelBytes = { landmarker: window.polaroica.bytes(bytes.landmarker), detector: window.polaroica.bytes(bytes.detector) };
      runtime = rt;
      const job = { data, width, height };
      const ws = modelBytes ? startWorkers() : null;
      if (!ws) return onPage(job);
      // The least busy worker; the pixels are handed over, not copied.
      const slot = ws.reduce((a, b) => (b.jobs < a.jobs ? b : a));
      slot.jobs++;
      const id = nextId++;
      return new Promise((resolve, reject) => {
        callbacks.set(id, { resolve, reject, job });
        const copy = new Uint8Array(data); // keep `data` for a fallback on the page
        slot.w.postMessage({ type: 'detect', id, data: copy, width, height }, [copy.buffer]);
      });
    },
  };
})();
