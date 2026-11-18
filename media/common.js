// Shared helpers for the Photo Library webviews. Loaded before grid.js / viewer.js.
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
    photo: 'M2 12l4-5 3 3.5 2-2 3 3.5z',
    undo: 'M5 6h5a3 3 0 0 1 0 6H7M7 3.5L4.5 6 7 8.5',
    redo: 'M11 6H6a3 3 0 0 0 0 6h3M9 3.5L11.5 6 9 8.5',
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

  function detailsList(rows) {
    const dl = h('dl');
    for (const r of rows || []) {
      dl.append(h('dt', {}, r.label), h('dd', {}, r.value));
    }
    return dl;
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
   * across photos and reloads of the tab.
   */
  function section(id, title, ...children) {
    const state = vscode.getState() || {};
    const closed = (state.closedSections || []).includes(id);
    const el = h(
      'details',
      { class: 'section', open: !closed, dataset: { section: id } },
      h('summary', {}, h('span', { class: 'chevron', 'aria-hidden': 'true' }, icon('right', 12)), title),
      h('div', { class: 'section-body' }, ...children),
    );
    el.addEventListener('toggle', () => {
      const st = vscode.getState() || {};
      const set = new Set(st.closedSections || []);
      if (el.open) {
        set.delete(id);
      } else {
        set.add(id);
      }
      vscode.setState({ ...st, closedSections: [...set] });
    });
    return el;
  }

  /** Marks an element as a photo for the right-click menu (Move to…, Reveal in OS). */
  function photoContext(name) {
    return JSON.stringify({ webviewSection: 'photo', photo: name, preventDefaultContextMenuItems: true });
  }

  window.vsphoto = { vscode, h, icon, crumbs, detailsList, picture, blobUrl, makeThumbnail, section, photoContext };
})();
