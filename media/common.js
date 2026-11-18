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

  /**
   * Loads images that are on screen, at most `max` at a time, top to bottom. Scrolling a
   * loading image away, or hiding the tab, cancels its download, so a slow network share is
   * never asked for photos nobody is looking at.
   */
  function createLoader(max, root) {
    const visible = new Set();
    const loading = new Set();
    let paused = false;

    const cancel = (img) => {
      img.onload = img.onerror = null;
      img.removeAttribute('src');
      loading.delete(img);
    };
    const pump = () => {
      if (paused || document.hidden) {
        return;
      }
      for (const img of visible) {
        if (loading.size >= max) {
          break;
        }
        if (img.dataset.loaded || loading.has(img)) {
          continue;
        }
        loading.add(img);
        img.onload = img.onerror = () => {
          img.onload = img.onerror = null;
          loading.delete(img);
          img.dataset.loaded = '1';
          img.classList.add('ready');
          pump();
        };
        img.src = img.dataset.src;
      }
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const img = e.target;
          if (e.isIntersecting) {
            visible.add(img);
          } else {
            visible.delete(img);
            if (loading.has(img)) {
              cancel(img);
            }
          }
        }
        pump();
      },
      { root: root || null, rootMargin: '200px' },
    );
    const pauseAll = () => {
      for (const img of [...loading]) {
        cancel(img);
      }
    };
    const onVisibility = () => (document.hidden ? pauseAll() : pump());
    let listening = false;

    return {
      observe(img) {
        if (!listening) {
          document.addEventListener('visibilitychange', onVisibility);
          listening = true;
        }
        io.observe(img);
      },
      /** Pause while the tab is hidden or the page needs the bandwidth for something else. */
      setPaused(p) {
        paused = p;
        if (p) {
          pauseAll();
        } else {
          pump();
        }
      },
      reset() {
        io.disconnect();
        document.removeEventListener('visibilitychange', onVisibility);
        listening = false;
        pauseAll();
        visible.clear();
      },
    };
  }

  window.vsphoto = { vscode, h, icon, crumbs, detailsList, picture, createLoader };
})();
