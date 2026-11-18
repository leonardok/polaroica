// Photo tab: one photo at full view; ← → browse the folder in this tab.
// The cached thumbnail shows at once, scaled up, while the original streams in from the share.
// With ADJUST open, or when the photo has edits, the photo is drawn with WebGL (adjust.js).
(function () {
  const { vscode, h, icon, crumbs, detailsList, panelResizer, closedByDefault, sectionOpen, blobUrl, section, photoContext, rankExplanation, keyBelongsToControl } = window.vsphoto;
  // The photo tab opens with only ADJUST expanded; DETAILS and AUTO-RANK stay folded until opened.
  closedByDefault.add('details');
  closedByDefault.add('autorank');
  const A = window.vsphotoAdjust;
  const app = document.getElementById('app');
  // 'fit', 'full' (one photo pixel per screen pixel) or a pinch-zoom scale (CSS px per photo px).
  let zoom = (vscode.getState() || {}).zoom || 'fit';
  let detailsBody, adjustSection, frameEl, noteEl, current, beforeBtn, undoBtn, redoBtn, stripCurrentDot;
  let urls = []; // object URLs of the current render, revoked on the next
  let preloads = []; // keep references so the browser doesn't cancel them

  // ---- editing state ----
  let edits = A.defaults(); // what's on screen
  let committed = A.defaults(); // last finished change (undo base)
  let undo = [];
  let redo = [];
  let pendingSave; // { name, edits, timer }
  let renderer; // one WebGL context, reused for every photo of this tab
  let glCanvas;
  let glName; // photo currently uploaded to the GPU
  let wantBytesFor;
  let drawQueued = false;
  let histTimer;

  // ---- culling state ----
  let cull = null; // { rating, flag, auto } of the current photo
  let progress = { picks: 0, rejects: 0, toGo: 0 };
  let rateBarEl, stripFlagEl;
  let autoAdvance = (vscode.getState() || {}).autoAdvance !== false;

  const post = (msg) => vscode.postMessage(msg);
  const track = (u) => (urls.push(u), u);

  const panel = A.createPanel({
    note: 'Saved next to the photo in .sidecar/ — the original file is never changed.',
    onChange: (e, commit) => change(e, commit),
    onCopy: (e) => {
      post({ type: 'copyEdits', edits: e });
      panel.setCanPaste(true);
    },
    onPaste: () => post({ type: 'pasteEdits' }),
  });

  function adjustOpen() {
    return sectionOpen('adjust');
  }

  function glWanted() {
    return adjustOpen() || !A.isDefault(edits);
  }

  // ---- rendering the tab ----------------------------------------------------------------

  function render(m) {
    flushSave();
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    current = m;
    edits = m.edits ? A.clone(m.edits) : A.defaults();
    committed = A.clone(edits);
    undo = [];
    redo = [];
    glName = undefined;
    wantBytesFor = undefined;
    panel.setReference(undefined); // this photo's own temperature arrives separately
    panel.set(edits);
    panel.setCanPaste(!!m.canPaste);
    panel.drawHistogram(undefined);
    cull = m.cull ? { ...m.cull } : null;
    progress = m.progress || { picks: 0, rejects: 0, toGo: 0 };
    if (renderer) {
      renderer.bypass = false;
    }

    const fitBtn = h('button', { class: 'btn' + (zoom === 'fit' ? ' on' : ''), 'aria-pressed': String(zoom === 'fit'), onclick: () => setZoom('fit') }, 'Fit');
    const fullBtn = h('button', { class: 'btn' + (zoom === 'full' ? ' on' : ''), 'aria-pressed': String(zoom === 'full'), onclick: () => setZoom('full') }, '100%');
    undoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', onclick: doUndo }, icon('undo'));
    redoBtn = h('button', { class: 'icon-btn', 'aria-label': 'Redo', title: 'Redo (Ctrl+Shift+Z)', onclick: doRedo }, icon('redo'));
    beforeBtn = h('button', { class: 'btn before', 'aria-pressed': 'false', title: 'Show the original (hold \\)', onclick: () => setBefore(!(renderer && renderer.bypass)) }, 'Before / After');

    noteEl = h('div', { class: 'loading', role: 'status' }, 'Loading photo…');
    frameEl = h('div', {
      class: 'frame ' + (zoom === 'fit' ? 'fit' : 'full'),
      ondblclick: () => post({ type: 'grid' }),
      title: 'Double-click to go back to the grid · right-click for more',
      'data-vscode-context': photoContext(m.photo.name),
    });
    frameEl.addEventListener('wheel', pinchZoom, { passive: false });
    if (m.thumb) {
      frameEl.append(h('img', { class: 'photo standin' + (m.thumbQuick ? ' soft' : ''), src: track(blobUrl(m.thumb, 'image/webp')), alt: '' }));
    }
    const drawable = !!m.photo.src || !!m.waitForPreview;
    if (!drawable) {
      frameEl.append(h('div', { class: 'photo raw-placeholder', role: 'img', 'aria-label': m.photo.name }, icon('photo', 22), m.photo.ext, h('span', { class: 'raw-note' }, 'Preview for this format is not supported yet')));
    } else {
      frameEl.append(noteEl);
    }

    const strip = h(
      'div',
      { class: 'strip', role: 'list', 'aria-label': 'Nearby photos' },
      m.strip.map((s) => {
        const dot = h('span', { class: 'edited-dot', title: 'Edited' });
        dot.hidden = !s.edited;
        const flagDot = h('span', { class: 'flag-dot' + (s.flag ? ' ' + s.flag : '') });
        if (s.index === m.index) {
          stripCurrentDot = dot;
          stripFlagEl = flagDot;
        }
        return h(
          'button',
          {
            class: 'strip-item' + (s.index === m.index ? ' current' : '') + (s.flag === 'reject' ? ' is-reject' : ''),
            'aria-label': s.name + (s.edited ? ' (edited)' : ''),
            'aria-current': s.index === m.index ? 'true' : undefined,
            title: s.name,
            onclick: () => post({ type: 'goto', index: s.index }),
          },
          s.thumb ? h('img', { class: 'strip-img', src: track(blobUrl(s.thumb, 'image/webp')), alt: '' }) : h('div', { class: 'strip-img raw-placeholder' }, s.ext),
          flagDot,
          dot,
        );
      }),
    );

    detailsBody = h('div', { class: 'section-content' });
    renderDetails([]);
    adjustSection = section('adjust', h('span', { class: 'section-title' }, 'ADJUST', h('span', { class: 'edited-label' }, 'edited')), panel.el);
    adjustSection.addEventListener('toggle', () => {
      if (adjustSection.open) {
        requestBytes();
      }
    });
    const autoSection = cull && cull.auto
      ? section('autorank', h('span', { class: 'section-title' }, 'AUTO-RANK', h('span', { class: 'section-summary' }, icon('spark', 10), cull.auto.group && cull.auto.group.size > 1 ? (cull.auto.group.best ? ` best of ${cull.auto.group.size}` : cull.auto.group.kept ? ` kept · 1 of ${cull.auto.group.size} similar` : ` 1 of ${cull.auto.group.size} similar`) : ' ranked')), rankExplanation(cull.auto))
      : null;
    const aside = h('aside', { class: 'details', 'aria-label': 'Photo panel' }, section('details', 'DETAILS', detailsBody), autoSection, adjustSection);
    rateBarEl = h('div', { class: 'ratebar' });
    paintRateBar();

    app.replaceChildren(
      h(
        'div',
        { class: 'layout' },
        h(
          'main',
          { class: 'main' },
          h(
            'div',
            { class: 'toolbar' },
            h('div', { class: 'grow' }, crumbs([...m.crumbs, m.photo.name])),
            h('span', { class: 'count' }, `${m.index + 1} of ${m.total.toLocaleString()}`),
            h('div', { class: 'tools' }, undoBtn, redoBtn),
            beforeBtn,
            h('div', { class: 'zoom' }, fitBtn, fullBtn),
          ),
          h(
            'div',
            { class: 'stage' },
            h('button', { class: 'nav', 'aria-label': 'Previous photo (←)', title: 'Previous (←)', onclick: () => post({ type: 'step', delta: -1 }) }, icon('left', 18)),
            frameEl,
            h('button', { class: 'nav', 'aria-label': 'Next photo (→)', title: 'Next (→)', onclick: () => post({ type: 'step', delta: 1 }) }, icon('right', 18)),
          ),
          rateBarEl,
          h('footer', { class: 'film' }, strip),
        ),
        panelResizer(aside, m.detailsWidth),
        aside,
      ),
    );
    strip.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    observeFrame();

    if (drawable && glWanted()) {
      requestBytes(); // drawn with WebGL: no need to load the plain image as well
    } else if (m.photo.src) {
      showMain(m.photo.src, m.photo.name);
    }
    paintEditState();
  }

  /** Puts the full photo on top of the stand-in; preloads neighbours once it's in. */
  function showMain(src, name) {
    const for_ = current;
    const img = h('img', { class: 'photo main', alt: name, decoding: 'async' });
    img.addEventListener('load', async () => {
      // Swap only once the big photo is decoded, so the stand-in never blinks away early.
      await img.decode().catch(() => undefined);
      if (current !== for_ || glName) {
        return;
      }
      img.classList.add('ready');
      frameEl.querySelector('.standin')?.remove();
      noteEl.remove();
      preload(for_);
    });
    img.addEventListener('error', () => {
      if (current === for_) {
        noteEl.textContent = 'Could not load this photo.';
      }
    });
    img.src = src;
    frameEl.insertBefore(img, noteEl.parentNode === frameEl ? noteEl : null);
  }

  function preload(m) {
    preloads = (m.preload || []).map((u) => {
      const p = new Image();
      p.decoding = 'async';
      p.src = u;
      return p;
    });
  }

  // ---- WebGL path ---------------------------------------------------------------------------

  function requestBytes() {
    if (!current || !(current.photo.src || current.waitForPreview)) {
      return;
    }
    if (glName === current.photo.name || wantBytesFor === current.photo.name) {
      return;
    }
    wantBytesFor = current.photo.name;
    noteEl.textContent = 'Loading photo…';
    if (!noteEl.parentNode) {
      frameEl.append(noteEl);
    }
    post({ type: 'needBytes', name: current.photo.name });
  }

  async function receiveBytes(m) {
    if (!current || m.name !== current.photo.name) {
      return;
    }
    wantBytesFor = undefined;
    if (!m.data) {
      noteEl.textContent = 'Could not load this photo for editing.';
      return;
    }
    const for_ = current;
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([m.data], { type: m.mime }), { imageOrientation: 'from-image' });
    } catch {
      noteEl.textContent = 'This format can’t be edited.';
      return;
    }
    try {
      if (current !== for_) {
        return;
      }
      if (!for_.photo.raw) {
        // A JPEG records no temperature: estimate it from the picture (RAW: the camera's, sent by the extension).
        panel.setReference({ kelvin: A.estimateKelvin(bitmap), source: 'estimated' });
      }
      if (!renderer) {
        glCanvas = h('canvas', { class: 'photo main gl ready' });
        renderer = new A.Renderer(glCanvas);
      }
      await renderer.setImage(bitmap);
    } catch {
      noteEl.textContent = 'Editing needs WebGL 2, which is not available here.';
      return;
    } finally {
      bitmap.close();
    }
    if (current !== for_) {
      return;
    }
    glName = for_.photo.name;
    renderer.bypass = false;
    renderer.setEdits(edits);
    // Replace whatever was showing (stand-in, plain image) with the canvas.
    frameEl.querySelectorAll('.standin, img.main').forEach((n) => n.remove());
    frameEl.insertBefore(glCanvas, frameEl.firstChild);
    noteEl.remove();
    layoutCanvas();
    histogramSoon(0);
    paintEditState();
    preload(for_);
  }

  function layoutCanvas() {
    if (!renderer || !glName || !glCanvas.isConnected || !renderer.width) {
      return;
    }
    const w = renderer.width;
    const hgt = renderer.height;
    const dpr = window.devicePixelRatio || 1;
    let cssW;
    let cssH;
    if (zoom === 'full') {
      cssW = w / dpr; // one photo pixel per screen pixel
      cssH = hgt / dpr;
    } else if (typeof zoom === 'number') {
      cssW = w * zoom; // pinch zoom
      cssH = hgt * zoom;
    } else {
      const s = Math.min(frameEl.clientWidth / w, frameEl.clientHeight / hgt);
      cssW = w * s;
      cssH = hgt * s;
    }
    glCanvas.style.width = cssW + 'px';
    glCanvas.style.height = cssH + 'px';
    glCanvas.width = Math.max(1, Math.min(w, Math.round(cssW * dpr)));
    glCanvas.height = Math.max(1, Math.min(hgt, Math.round(cssH * dpr)));
    renderer.draw();
  }

  let resizeObs;
  function observeFrame() {
    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(() => layoutCanvas());
    resizeObs.observe(frameEl);
  }

  function drawSoon() {
    if (drawQueued || !renderer || !glName) {
      return;
    }
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      renderer.draw();
    });
  }

  function histogramSoon(delay = 120) {
    clearTimeout(histTimer);
    histTimer = setTimeout(() => {
      if (renderer && glName) {
        panel.drawHistogram(renderer.histogram());
      }
    }, delay);
  }

  // ---- edits ----------------------------------------------------------------------------------

  function change(e, commit) {
    edits = e;
    if (renderer && glName) {
      renderer.setEdits(edits);
      drawSoon();
      histogramSoon();
    } else {
      requestBytes();
    }
    if (commit && !A.same(committed, edits)) {
      undo.push(committed);
      redo = [];
      committed = A.clone(edits);
      saveSoon();
    }
    paintEditState();
  }

  function apply(e) {
    edits = A.clone(e);
    committed = A.clone(e);
    panel.set(edits);
    if (renderer && glName) {
      renderer.setEdits(edits);
      drawSoon();
      histogramSoon();
    } else if (!A.isDefault(edits)) {
      requestBytes();
    }
    saveSoon();
    paintEditState();
  }

  function doUndo() {
    if (!undo.length) {
      return;
    }
    redo.push(A.clone(committed));
    apply(undo.pop());
  }

  function doRedo() {
    if (!redo.length) {
      return;
    }
    undo.push(A.clone(committed));
    apply(redo.pop());
  }

  /** Saves half a second after the last finished change (the extension writes the sidecar). */
  function saveSoon() {
    if (pendingSave) {
      clearTimeout(pendingSave.timer);
    }
    pendingSave = { name: current?.photo.name, edits: A.clone(committed) };
    pendingSave.timer = setTimeout(flushSave, 500);
  }

  function flushSave() {
    if (!pendingSave) {
      return;
    }
    clearTimeout(pendingSave.timer);
    post({ type: 'saveEdits', name: pendingSave.name, edits: pendingSave.edits });
    pendingSave = undefined;
  }

  function setBefore(on) {
    if (!renderer || !glName) {
      return;
    }
    renderer.bypass = on;
    beforeBtn.setAttribute('aria-pressed', String(on));
    beforeBtn.classList.toggle('on', on);
    drawSoon();
  }

  function paintEditState() {
    const isEdited = !A.isDefault(edits);
    adjustSection?.classList.toggle('is-edited', isEdited);
    if (stripCurrentDot) {
      stripCurrentDot.hidden = !isEdited;
    }
    if (undoBtn) {
      undoBtn.disabled = !undo.length;
      redoBtn.disabled = !redo.length;
      beforeBtn.disabled = !glName;
    }
  }

  function setZoom(z) {
    zoom = z;
    if (typeof z === 'string') {
      vscode.setState({ ...(vscode.getState() || {}), zoom }); // a pinch scale is not kept across reloads
    }
    if (frameEl) {
      frameEl.classList.toggle('fit', z === 'fit');
      frameEl.classList.toggle('full', z !== 'fit');
    }
    document.querySelectorAll('.zoom .btn').forEach((b, i) => {
      const on = i === 0 ? z === 'fit' : z === 'full';
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    layoutCanvas();
  }

  /**
   * Pinch on a trackpad (Chromium reports it as a wheel event with Ctrl held), or Ctrl/⌘ + mouse
   * wheel: zoom around the pointer, from Fit up to 400%. Zooming out past Fit snaps back to Fit.
   */
  function pinchZoom(e) {
    if (!e.ctrlKey && !e.metaKey) {
      return; // plain scrolling pans the zoomed photo
    }
    e.preventDefault();
    if (!renderer || !glName || !glCanvas.isConnected || !renderer.width) {
      setZoom(e.deltaY < 0 ? 'full' : 'fit'); // not drawn with WebGL: just Fit / 100%
      return;
    }
    const w = renderer.width;
    const hgt = renderer.height;
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(frameEl.clientWidth / w, frameEl.clientHeight / hgt);
    const now = zoom === 'fit' ? fit : zoom === 'full' ? 1 / dpr : zoom;
    const delta = Math.max(-50, Math.min(50, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
    const next = Math.min(Math.max(fit, 4 / dpr), now * Math.exp(-delta * 0.01));
    // Keep the photo point under the pointer where it is.
    const r = glCanvas.getBoundingClientRect();
    const rx = (e.clientX - r.left) / r.width;
    const ry = (e.clientY - r.top) / r.height;
    if (next <= fit * 1.01) {
      if (zoom !== 'fit') setZoom('fit');
      return;
    }
    setZoom(Math.abs(next * dpr - 1) < 0.01 ? 'full' : next);
    const r2 = glCanvas.getBoundingClientRect();
    frameEl.scrollLeft += r2.left + rx * r2.width - e.clientX;
    frameEl.scrollTop += r2.top + ry * r2.height - e.clientY;
  }

  // ---- rating bar ------------------------------------------------------------------------------

  function paintRateBar() {
    if (!rateBarEl) return;
    const c = cull || {};
    const spark = c.auto ? icon('spark', 10) : null;
    if (spark) {
      spark.setAttribute('fill', 'currentColor');
      spark.setAttribute('stroke', 'none');
      spark.classList.add('spark');
    }
    rateBarEl.replaceChildren(
      h(
        'div',
        { class: 'flags' },
        h('button', { class: 'flag-btn' + (c.flag === 'pick' ? ' pick' : ''), 'aria-pressed': String(c.flag === 'pick'), title: 'Pick (P)', onclick: () => rate({ flag: c.flag === 'pick' ? null : 'pick' }) }, icon('check', 12), 'Pick ', h('kbd', {}, 'P')),
        h('button', { class: 'flag-btn' + (c.flag === 'reject' ? ' reject' : ''), 'aria-pressed': String(c.flag === 'reject'), title: 'Reject (X)', onclick: () => rate({ flag: c.flag === 'reject' ? null : 'reject' }) }, icon('x', 12), 'Reject ', h('kbd', {}, 'X')),
      ),
      h(
        'div',
        { class: 'star-row', role: 'radiogroup', 'aria-label': 'Stars' },
        [1, 2, 3, 4, 5].map((k) => h('button', { class: 'star' + (k <= (c.rating || 0) ? ' on' : ''), role: 'radio', 'aria-checked': String(c.rating === k), 'aria-label': `${k} star${k > 1 ? 's' : ''}`, title: `${k} (key ${k})`, onclick: () => rate({ rating: c.rating === k ? 0 : k }) }, '★')),
        spark,
      ),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: autoAdvance, onchange: (e) => { autoAdvance = e.target.checked; vscode.setState({ ...(vscode.getState() || {}), autoAdvance }); } }), 'Auto-advance'),
      h('span', { class: 'cull-progress' }, `${progress.picks} picks · ${progress.rejects} rejects · ${progress.toGo} to go`),
    );
  }

  function rate(change) {
    if (!current) return;
    const before = (cull && cull.flag) || null;
    cull = Object.assign({ rating: 0 }, cull || {});
    if ('rating' in change) cull.rating = change.rating;
    if ('flag' in change) cull.flag = change.flag || undefined;
    delete cull.auto;
    const after = cull.flag || null;
    if (before !== after) {
      // keep the counts right without asking the extension
      if (before === 'pick') progress.picks--;
      else if (before === 'reject') progress.rejects--;
      else progress.toGo--;
      if (after === 'pick') progress.picks++;
      else if (after === 'reject') progress.rejects++;
      else progress.toGo++;
    }
    post({ type: 'rate', name: current.photo.name, ...change });
    paintRateBar();
    if (stripFlagEl) {
      stripFlagEl.className = 'flag-dot' + (cull.flag ? ' ' + cull.flag : '');
      stripFlagEl.parentElement && stripFlagEl.parentElement.classList.toggle('is-reject', cull.flag === 'reject');
    }
    if (autoAdvance) {
      const name = current.photo.name;
      setTimeout(() => {
        if (current && current.photo.name === name) post({ type: 'step', delta: 1 });
      }, 180);
    }
  }

  function renderDetails(rows) {
    if (!detailsBody) {
      return;
    }
    detailsBody.replaceChildren(
      h('div', { class: 'name', title: current?.photo.name || '' }, current?.photo.name || ''),
      detailsList(rows),
    );
  }

  // ---- keys -----------------------------------------------------------------------------------

  const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        doRedo();
      } else {
        doUndo();
      }
      return;
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      doRedo();
      return;
    }
    if (e.altKey || mod || keyBelongsToControl(e)) {
      return; // e.g. arrows inside a slider adjust the slider
    }
    if (e.key === 'p' || e.key === 'P') {
      rate({ flag: 'pick' });
    } else if (e.key === 'x' || e.key === 'X') {
      rate({ flag: 'reject' });
    } else if (e.key === 'u' || e.key === 'U') {
      rate({ flag: null });
    } else if (/^[0-5]$/.test(e.key)) {
      rate({ rating: Number(e.key) });
    } else if (e.key === '\\') {
      setBefore(true);
    } else if (e.key === 'ArrowLeft') {
      post({ type: 'step', delta: -1 });
    } else if (e.key === 'ArrowRight') {
      post({ type: 'step', delta: 1 });
    } else if (e.key === 'Home') {
      post({ type: 'goto', index: 0 });
    } else {
      return;
    }
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === '\\') {
      setBefore(false);
    }
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'show':
        render(m);
        break;
      case 'placeholder':
        // Small EXIF preview while the original loads (no cached thumbnail yet).
        if (current && current.photo.name === m.name && frameEl && !frameEl.querySelector('.standin') && !frameEl.querySelector('.main.ready')) {
          frameEl.prepend(h('img', { class: 'photo standin soft', src: track(blobUrl(m.data, 'image/webp')), alt: '' }));
        }
        break;
      case 'preview':
        // RAW: the JPEG preview embedded in the file (not needed when drawing with WebGL).
        if (current && current.photo.name === m.name && !glWanted()) {
          if (m.data) {
            showMain(track(blobUrl(m.data, 'image/jpeg')), m.name);
          } else {
            noteEl.textContent = 'This RAW file has no preview we can show.';
          }
        }
        break;
      case 'whiteBalance':
        if (current && current.photo.name === m.name) {
          panel.setReference({ kelvin: m.kelvin, source: m.source });
        }
        break;
      case 'bytes':
        void receiveBytes(m);
        break;
      case 'paste':
        undo.push(A.clone(committed));
        redo = [];
        apply(m.edits);
        break;
      case 'details':
        renderDetails(m.rows);
        break;
      case 'empty':
        app.replaceChildren(h('div', { class: 'message' }, 'This folder has no photos any more.'));
        break;
      case 'error':
        app.replaceChildren(h('div', { class: 'message' }, m.message));
        break;
    }
  });

  window.addEventListener('beforeunload', flushSave);

  post({ type: 'ready' });
})();
