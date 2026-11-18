// Shared helpers for the Polaroica webviews. Loaded before grid.js / viewer.js.
/* global acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();

  /** Tiny element builder: h('div', {class: 'x', onclick}, child, 'text'). */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) {
        continue;
      }
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v);
      } else if (k === 'class') {
        el.className = v;
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) {
        continue;
      }
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 3v3h-3',
    left: 'M10 3L5 8l5 5',
    right: 'M6 3l5 5-5 5',
    photo: 'M3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3zM3 12l3.5-4 2.5 3 1.5-1.5L13 12M10 6a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    undo: 'M5 6h5a3 3 0 0 1 0 6H7M7 3.5L4.5 6 7 8.5',
    check: 'M3 8.5l3 3 7-7',
    x: 'M4 4l8 8M12 4l-8 8',
    spark: 'M8 1.5l1.6 4.9 4.9 1.6-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z',
    redo: 'M11 6H6a3 3 0 0 0 0 6h3M9 3.5L11.5 6 9 8.5',
    trash: 'M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.5 6.5v5M9.5 6.5v5',
    export: 'M8 10V2M5 5l3-3 3 3M3 9v4.5h10V9',
    filter: 'M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z',
    // A frame split in two, the right half hatched: original | edited.
    compare: 'M2.5 3.5h11v9h-11zM8 2v12M9.5 7.5l2-2M9.5 10.5l4-4',
    // Corners around a picture: the whole photo in the window.
    fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10M5.5 5.5h5v5h-5z',
    // A magnifier with a "1" in it: one photo pixel per screen pixel.
    actual: 'M7 2.5a4.5 4.5 0 1 1 0 9a4.5 4.5 0 1 1 0-9M10.3 10.3l3.2 3.2M6 5.8l1.2-.8v4',
  };
  function icon(name, size) {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('width', String(size || 16));
    s.setAttribute('height', String(size || 16));
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.4');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', ICONS[name]);
    s.append(p);
    return s;
  }

  function crumbs(parts) {
    const el = h('nav', { class: 'crumbs', 'aria-label': 'Location' });
    parts.forEach((p, i) => {
      if (i) {
        el.append(h('span', { 'aria-hidden': 'true' }, '›'));
      }
      el.append(h('span', { class: i === parts.length - 1 ? 'last' : '' }, p));
    });
    return el;
  }

  /** Label / value rows, one line each: a value too long for the panel ends in "…" (full text on hover). */
  function detailsList(rows) {
    const dl = h('dl');
    for (const r of rows || []) {
      const path = r.label === 'Location';
      dl.append(
        h('dt', { title: r.label }, r.label),
        // A path is cut at its start, so the end (the album) stays in view.
        h('dd', { class: path ? 'path' : '', title: `${r.label}: ${r.value}` }, path ? h('bdi', { dir: 'ltr' }, r.value) : r.value),
      );
    }
    return dl;
  }

  /**
   * A drag handle on the left edge of the side panel: drag (or ←/→ when focused) to change its
   * width, double-click for the default. The width is sent to the extension, which remembers it
   * for every tab ({ type: 'detailsWidth', width }, 0 = default).
   */
  const PANEL_MIN = 220;
  const PANEL_MAX = 640;
  function setPanelWidth(panel, w) {
    panel.style.flex = w ? `0 0 ${w}px` : '';
    panel.style.width = w ? w + 'px' : '';
    panel.style.maxWidth = w ? 'none' : '';
  }
  function panelResizer(panel, width) {
    setPanelWidth(panel, width || 0);
    const handle = h('div', {
      class: 'resizer',
      role: 'separator',
      tabindex: '0',
      'aria-orientation': 'vertical',
      'aria-label': 'Resize the side panel',
      'aria-valuemin': String(PANEL_MIN),
      'aria-valuemax': String(PANEL_MAX),
      title: 'Drag to resize · double-click for the default width',
    });
    let saveTimer;
    const save = (w) => {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => vscode.postMessage({ type: 'detailsWidth', width: w }), 250);
    };
    const set = (w) => {
      const max = Math.max(PANEL_MIN, Math.min(PANEL_MAX, window.innerWidth - 360));
      w = Math.round(Math.max(PANEL_MIN, Math.min(max, w)));
      setPanelWidth(panel, w);
      handle.setAttribute('aria-valuenow', String(w));
      save(w);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const x0 = e.clientX;
      const w0 = panel.getBoundingClientRect().width;
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = (ev) => set(w0 + (x0 - ev.clientX));
      const up = () => {
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation(); // not the tab's own arrow keys
        set(panel.getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 16 : -16));
      }
    });
    handle.addEventListener('dblclick', () => {
      setPanelWidth(panel, 0);
      handle.removeAttribute('aria-valuenow');
      save(0);
    });
    return handle;
  }

  /**
   * Thumbnail or a labelled placeholder for formats a browser can't draw (RAW, TIFF, HEIC).
   * With a loader, the <img> gets its src only when the loader decides (on screen, in turn).
   */
  function picture(photo, cls, loader) {
    if (photo.src) {
      const img = h('img', { class: cls, alt: photo.name, decoding: 'async', draggable: 'false' });
      if (loader) {
        img.dataset.src = photo.src;
        loader.observe(img);
      } else {
        img.src = photo.src;
      }
      return img;
    }
    return h(
      'div',
      { class: cls + ' raw-placeholder', role: 'img', 'aria-label': photo.name },
      icon('photo', 22),
      photo.ext || 'FILE',
    );
  }

  /** Object URL for bytes sent by the extension (Uint8Array). */
  function blobUrl(data, mime) {
    return URL.createObjectURL(new Blob([bytes(data)], { type: mime }));
  }

  /** Bytes from a message: Uint8Array normally; tolerate {type:'Buffer',data:[...]} and arrays. */
  function bytes(data) {
    if (data instanceof Uint8Array) {
      return data;
    }
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (Array.isArray(data)) {
      return Uint8Array.from(data);
    }
    if (data && data.type === 'Buffer' && Array.isArray(data.data)) {
      return Uint8Array.from(data.data);
    }
    if (data && typeof data === 'object') {
      return Uint8Array.from(Object.values(data)); // {"0":255,"1":216,...}
    }
    return new Uint8Array(0);
  }

  /**
   * Decode a photo and shrink it to a WebP thumbnail (long edge `px`). Runs in the webview
   * because it has the browser's image decoders; the extension stores the result.
   */
  async function makeThumbnail(data, mime, px) {
    const blob = new Blob([bytes(data)], { type: mime });
    let source;
    try {
      source = await createImageBitmap(blob); // applies EXIF orientation
    } catch {
      // e.g. SVG: go through an <img>
      const url = URL.createObjectURL(blob);
      try {
        source = await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = url;
        });
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    }
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    const scale = Math.min(1, px / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    let drawable = source;
    if (source instanceof ImageBitmap && scale < 1) {
      drawable = await createImageBitmap(source, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      source.close();
    }
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(drawable, 0, 0, w, h);
    if (drawable instanceof ImageBitmap) {
      drawable.close();
    }
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.6 });
    return { data: new Uint8Array(await out.arrayBuffer()), w, h };
  }

  /**
   * A collapsible panel section (DETAILS, ADJUST…). Open/closed is remembered per section id
   * across photos and reloads of the tab; until you toggle it, a section is open unless the page
   * lists it in `closedByDefault`.
   */
  const closedByDefault = new Set();
  function sectionOpen(id) {
    const saved = ((vscode.getState() || {}).sections || {})[id];
    return saved === undefined ? !closedByDefault.has(id) : saved;
  }
  function section(id, title, ...children) {
    const el = h(
      'details',
      { class: 'section', open: sectionOpen(id), dataset: { section: id } },
      h('summary', {}, h('span', { class: 'chevron', 'aria-hidden': 'true' }, icon('right', 12)), title),
      h('div', { class: 'section-body' }, ...children),
    );
    el.addEventListener('toggle', () => {
      const st = vscode.getState() || {};
      vscode.setState({ ...st, sections: { ...(st.sections || {}), [id]: el.open } });
    });
    return el;
  }

  /**
   * Radar chart for "why this rank": axes [{label, value 0–100, avg?}]. The photo is a filled
   * shape; with `withAvg`, the average of its similar shots is a dashed outline.
   */
  function radar(axes, withAvg) {
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const W = 300, H = 232, cx = 150, cy = 114, R = 64, n = axes.length;
    const pt = (i, v, r = R) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
      return [cx + (r * v * Math.cos(a)) / 100, cy + (r * v * Math.sin(a)) / 100];
    };
    const poly = (vals) => vals.map((v, i) => pt(i, v).map((x) => x.toFixed(1)).join(',')).join(' ');
    const svg = el('svg', { viewBox: `-48 0 ${W + 96} ${H}`, class: 'radar', role: 'img', // side room for labels
      'aria-label': 'Why this rank, out of 100: ' + axes.map((a) => `${a.label} ${a.value}`).join(', ') + (withAvg ? '. Dashed: average of its similar shots.' : '') });
    for (const r of [25, 50, 75, 100]) svg.append(el('polygon', { points: poly(axes.map(() => r)), class: 'radar-ring' }));
    svg.append(el('path', { d: axes.map((_, i) => `M${cx} ${cy}L${pt(i, 100).join(' ')}`).join(''), class: 'radar-ring' }));
    if (withAvg && axes.every((a) => a.avg !== undefined)) svg.append(el('polygon', { points: poly(axes.map((a) => a.avg)), class: 'radar-avg' }));
    svg.append(el('polygon', { points: poly(axes.map((a) => a.value)), class: 'radar-shape' }));
    axes.forEach((a, i) => {
      const [x, y] = pt(i, a.value);
      const dot = el('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 4, class: 'radar-dot' });
      dot.append(el('title', {}, `${a.label}: ${a.value} of 100` + (a.avg !== undefined ? ` (similar shots average ${Math.round(a.avg)})` : '')));
      svg.append(dot);
      const [lx, ly] = pt(i, 114);
      const anchor = Math.abs(lx - cx) < 5 ? 'middle' : lx > cx ? 'start' : 'end';
      const dy = ly < cy - 5 ? -6 : ly > cy + 5 ? 12 : 4;
      const t = el('text', { x: lx.toFixed(1), y: (ly + dy).toFixed(1), 'text-anchor': anchor, class: 'radar-label' }, a.label + ' ');
      t.append(el('tspan', { class: 'radar-value' }, String(a.value)));
      svg.append(t);
    });
    const legend = h('div', { class: 'radar-legend' },
      h('span', {}, h('span', { class: 'sw-shape', 'aria-hidden': 'true' }), 'This photo'),
      withAvg ? h('span', {}, h('span', { class: 'sw-avg', 'aria-hidden': 'true' }), 'Average of its similar shots') : null);
    return h('div', { class: 'radar-wrap' }, svg, legend);
  }

  const RANK_AXES = [
    ['focus', 'Focus'],
    ['exposure', 'Exposure'],
    ['similar', 'vs. similar'],
    ['eyes', 'Eyes open'],
    ['looking', 'Looking'],
    ['smile', 'Smiling'],
    ['natural', 'Natural'],
    ['framing', 'Framing'],
  ];

  /** Radar (or a list when fewer than 3 criteria) plus the one-line reason of an Auto-Rank. */
  function rankExplanation(auto) {
    const axes = RANK_AXES.filter(([k]) => auto.scores && auto.scores[k] !== undefined).map(([k, label]) => ({
      label,
      value: Math.round(auto.scores[k]),
      avg: auto.groupAvg ? auto.groupAvg[k] : undefined,
    }));
    return h(
      'div',
      { class: 'rank-why' },
      h('div', { class: 'rating-title' }, 'WHY THIS RANK'),
      axes.length >= 3 ? radar(axes, !!auto.groupAvg) : detailsList(axes.map((a) => ({ label: a.label, value: String(a.value) }))),
      auto.reason ? h('p', { class: 'reason' }, auto.reason) : null,
    );
  }

  /** Marks an element as a photo for the right-click menu (Move to…, Reveal in OS). */
  function photoContext(name) {
    return JSON.stringify({ webviewSection: 'photo', photo: name, preventDefaultContextMenuItems: true });
  }

  /**
   * Should a key press go to the focused control instead of the page's shortcuts? Text fields get
   * every key; sliders and dropdowns get arrows/Home/End; checkboxes and buttons get none.
   */
  function keyBelongsToControl(e) {
    const t = e.target;
    if (!t || !t.tagName) return false;
    const tag = t.tagName;
    const textual = tag === 'TEXTAREA' || (tag === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(t.type));
    if (textual || t.isContentEditable) return true;
    const navKey = /^(Arrow|Home|End|Page)/.test(e.key);
    return navKey && (tag === 'SELECT' || (tag === 'INPUT' && t.type === 'range'));
  }

  window.polaroica = { vscode, h, icon, crumbs, detailsList, panelResizer, closedByDefault, sectionOpen, picture, blobUrl, bytes, makeThumbnail, section, photoContext, radar, rankExplanation, keyBelongsToControl };
})();
