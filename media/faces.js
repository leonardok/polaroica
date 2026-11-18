// Face expression scores for Auto-Rank. MediaPipe runs here, in the page (it needs a browser),
// entirely on this computer. Two steps: a face detector finds every face, then Face Landmarker
// reads each face on its own crop (asked for several faces at once it misses some, reports some
// twice and mixes up their expressions). The extension sends a photo; this returns, per face, how
// open the eyes are, whether the person faces the camera, smiles, or was caught mid-word.
(function () {
  let models; // Promise<{ detector: FaceDetector, landmarker: FaceLandmarker }>
  /** Model files as bytes, sent once by the extension (kept so a failed load can be retried). */
  let modelBytes;

  function load(rt) {
    if (!models) {
      models = (async () => {
        // The plain-script build (global `Vision`): a module (.mjs) import depends on the editor
        // serving the right MIME type for .mjs, which not every VS Code build does.
        if (!window.Vision) {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = rt.bundle;
            s.onload = resolve;
            s.onerror = () => reject(new Error('could not load the face library (' + rt.bundle + ')'));
            document.head.append(s);
          });
        }
        const { FilesetResolver, FaceLandmarker, FaceDetector } = window.Vision;
        if (!modelBytes) throw new Error('the face models were not received');
        const fileset = await FilesetResolver.forVisionTasks(rt.wasm);
        // CPU: predictable in every editor (the GPU path can stall in a webview).
        const detector = await FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: modelBytes.detector, delegate: 'CPU' },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.5,
        });
        const landmarker = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: modelBytes.landmarker, delegate: 'CPU' },
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
      looking = 100 * clamp01(1 - (Math.abs(yaw) / 35 + Math.abs(pitch) / 30) / 1);
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

  /** Faces in a photo: upright RGBA pixels (already shrunk by the extension). */
  async function detect(data, width, height, rt) {
    const { detector, landmarker } = await load(rt);
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
          out.push(metric(r.faceBlendshapes[0] || { categories: [] }, (r.facialTransformationMatrixes || [])[0], area));
        } finally {
          crop.close();
        }
      }
      return out;
    } finally {
      image.close();
    }
  }

  // One photo at a time: the model isn't re-entrant and this keeps memory flat.
  let queue = Promise.resolve();
  window.vsphoto.faces = {
    detect: (data, width, height, rt, bytes) => {
      if (bytes) modelBytes = { landmarker: window.vsphoto.bytes(bytes.landmarker), detector: window.vsphoto.bytes(bytes.detector) };
      const run = queue.then(() => detect(data, width, height, rt));
      queue = run.catch(() => undefined);
      return run;
    },
  };
})();
