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

  /** Thumbnail or a labelled placeholder for formats a browser can't draw (RAW, TIFF, HEIC). */
  function picture(photo, cls, lazy) {
    if (photo.src) {
      return h('img', {
        class: cls,
        src: photo.src,
        alt: photo.name,
        loading: lazy ? 'lazy' : undefined,
        decoding: 'async',
        draggable: 'false',
      });
    }
    return h(
      'div',
      { class: cls + ' raw-placeholder', role: 'img', 'aria-label': photo.name },
      icon('photo', 22),
      photo.ext || 'FILE',
    );
  }

  window.vsphoto = { vscode, h, icon, crumbs, detailsList, picture };
})();
