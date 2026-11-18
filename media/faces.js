// Face expression scores for Auto-Rank. MediaPipe Face Landmarker runs here, in the page (it needs
// a browser), entirely on this computer. The extension sends a photo; this returns, per face, how
// open the eyes are, whether the person faces the camera, smiles, or was caught mid-word.
(function () {
  let landmarker; // Promise<FaceLandmarker>

  function load(rt) {
    if (!landmarker) {
      landmarker = (async () => {
        const { FilesetResolver, FaceLandmarker } = await import(rt.bundle);
        const fileset = await FilesetResolver.forVisionTasks(rt.wasm);
        const options = (delegate) => ({
          baseOptions: { modelAssetPath: rt.model, delegate },
          runningMode: 'IMAGE',
          numFaces: 10,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
        try {
          return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
        } catch {
          return await FaceLandmarker.createFromOptions(fileset, options('CPU'));
        }
      })();
      landmarker.catch(() => (landmarker = undefined));
    }
    return landmarker;
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  /** Scores 0–100 for one face from its blendshapes, head pose and landmarks. */
  function metric(shapes, matrix, points) {
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

    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
    const r = (n) => Math.round(n);
    return { area: Math.round(area * 10000) / 10000, eyes: r(eyes), looking: r(looking), smile: r(smile), natural: r(natural) };
  }

  /** Faces in a photo (JPEG bytes). Detection runs on a copy at most 1600 px wide. */
  async function detect(data, mime, rt) {
    const fl = await load(rt);
    const blob = new Blob([data], { type: mime || 'image/jpeg' });
    let bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const long = Math.max(bmp.width, bmp.height);
    if (long > 1600) {
      const k = 1600 / long;
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    try {
      const res = fl.detect(bmp);
      return res.faceLandmarks.map((pts, i) =>
        metric(res.faceBlendshapes[i] || { categories: [] }, (res.facialTransformationMatrixes || [])[i], pts),
      );
    } finally {
      bmp.close();
    }
  }

  // One photo at a time: the model isn't re-entrant and this keeps memory flat.
  let queue = Promise.resolve();
  window.vsphoto.faces = {
    detect: (data, mime, rt) => {
      const run = queue.then(() => detect(data, mime, rt));
      queue = run.catch(() => undefined);
      return run;
    },
  };
})();
