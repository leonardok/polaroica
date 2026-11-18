// Library view: photo grid for one folder. Shows thumbnails only (never the originals): the
// extension sends cached ones, placeholders, and asks this page to decode + shrink the rest.
(function () {
  const { vscode, h, icon, crumbs, detailsList, blobUrl, makeThumbnail, section, photoContext } = window.vsphoto;
  const app = document.getElementById('app');

  let photos = [];
  let selected = new Set();
  let anchor = -1; // index for shift-click ranges
  let focusIndex = -1;
  let sort = 'name';
  let tileSize = (vscode.getState() || {}).tileSize || 160;
  let tiles = [];
  let tileByName = new Map();
  let gridEl, detailsEl, countEl;
  /** name -> { url, kind: 'thumb' | 'placeholder' }. Kept across re-renders of the same folder. */
  const thumbs = new Map();
  const onScreen = new Set();
  let observer;
  let reportTimer;

  const post = (msg) => vscode.postMessage(msg);

  // ---- thumbnails --------------------------------------------------------------------

  function applyThumb(tile, name) {
    const t = thumbs.get(name);
    if (!t) {
      return;
    }
    const img = tile.querySelector('img');
    if (img.getAttribute('src') !== t.url) {
      img.src = t.url;
    }
    tile.classList.add('has-thumb');
    tile.classList.toggle('is-placeholder', t.kind === 'placeholder');
  }

  function receiveThumbs(items) {
    for (const it of items) {
      const prev = thumbs.get(it.name);
      if (prev && prev.kind === 'thumb' && it.kind === 'placeholder') {
        continue;
      }
      if (prev) {
        URL.revokeObjectURL(prev.url);
      }
      thumbs.set(it.name, { url: blobUrl(it.data, it.mime), kind: it.kind });
      const tile = tileByName.get(it.name);
      if (tile) {
        applyThumb(tile, it.name);
      }
    }
  }

  async function decode(m) {
    try {
      const t = await makeThumbnail(m.data, m.mime, m.px);
      post({ type: 'decoded', id: m.id, data: t.data, w: t.w, h: t.h });
    } catch {
      post({ type: 'decoded', id: m.id });
    }
  }

  /** Tell the extension which photos are on (or near) screen, top to bottom. */
  function reportOnScreen() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      const idx = [...onScreen].sort((a, b) => a - b);
      post({ type: 'onscreen', names: idx.map((i) => photos[i].name) });
    }, 60);
  }

  // ---- selection ---------------------------------------------------------------------

  function sendSelection() {
    const focus = focusIndex >= 0 ? photos[focusIndex]?.name : undefined;
    post({ type: 'select', names: [...selected], focus });
    countEl.textContent = summary();
  }

  function summary() {
    const n = photos.length;
    return `${n.toLocaleString()} photo${n === 1 ? '' : 's'}${selected.size ? ` · ${selected.size} selected` : ''}`;
  }

  function paintSelection() {
    tiles.forEach((t, i) => {
      const on = selected.has(photos[i].name);
      t.classList.toggle('selected', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function select(i, ev) {
    const name = photos[i].name;
    if (ev && ev.shiftKey && anchor >= 0) {
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      if (!(ev.ctrlKey || ev.metaKey)) {
        selected.clear();
      }
      for (let k = a; k <= b; k++) {
        selected.add(photos[k].name);
      }
    } else if (ev && (ev.ctrlKey || ev.metaKey)) {
      if (selected.has(name)) {
        selected.delete(name);
      } else {
        selected.add(name);
      }
      anchor = i;
    } else {
      selected = new Set([name]);
      anchor = i;
    }
    focusIndex = i;
    paintSelection();
    sendSelection();
  }

  function moveFocus(delta) {
    if (!photos.length) {
      return;
    }
    const next = Math.max(0, Math.min(photos.length - 1, (focusIndex < 0 ? 0 : focusIndex) + delta));
    tiles[next].focus();
    tiles[next].scrollIntoView({ block: 'nearest' });
    select(next, null);
  }

  function columns() {
    if (!tiles.length) {
      return 1;
    }
    const top = tiles[0].offsetTop;
    let c = 0;
    while (c < tiles.length && tiles[c].offsetTop === top) {
      c++;
    }
    return Math.max(1, c);
  }

  // ---- rendering ---------------------------------------------------------------------

  function render(state) {
    photos = state.photos;
    sort = state.sort;
    if (!(vscode.getState() || {}).tileSize && state.tileSize) {
      tileSize = state.tileSize;
    }
    const names = new Set(photos.map((p) => p.name));
    for (const [name, t] of thumbs) {
      if (!names.has(name)) {
        URL.revokeObjectURL(t.url);
        thumbs.delete(name);
      }
    }
    selected = new Set((state.selected || []).filter((n) => names.has(n)));

    const sortSel = h(
      'select',
      { 'aria-label': 'Sort by', onchange: (e) => post({ type: 'sort', key: e.target.value }) },
      [
        ['name', 'File name'],
        ['modified', 'Date modified'],
        ['size', 'File size'],
      ].map(([v, l]) => h('option', { value: v, selected: v === sort }, l)),
    );
    const size = h('input', {
      type: 'range',
      min: '90',
      max: '280',
      step: '10',
      value: String(tileSize),
      'aria-label': 'Thumbnail size',
      oninput: (e) => {
        tileSize = Number(e.target.value);
        gridEl.style.setProperty('--tile', tileSize + 'px');
        vscode.setState({ ...(vscode.getState() || {}), tileSize });
      },
      onchange: () => post({ type: 'tileSize', size: tileSize }),
    });
    countEl = h('span', { class: 'count' }, summary());

    gridEl = h('div', {
      class: 'grid',
      role: 'listbox',
      'aria-multiselectable': 'true',
      'aria-label': 'Photos',
      onkeydown: onKey,
    });
    gridEl.style.setProperty('--tile', tileSize + 'px');

    if (observer) {
      observer.disconnect();
    }
    onScreen.clear();
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const i = Number(e.target.dataset.i);
          if (e.isIntersecting) {
            onScreen.add(i);
          } else {
            onScreen.delete(i);
          }
        }
        reportOnScreen();
      },
      { rootMargin: '600px 0px' },
    );

    tileByName = new Map();
    tiles = photos.map((p, i) => {
      const tile = h(
        'button',
        {
          class: 'tile',
          role: 'option',
          title: `${p.name}\nDouble-click to open in a new tab`,
          draggable: 'true',
          dataset: { i: String(i) },
          onclick: (e) => select(i, e),
          ondblclick: () => post({ type: 'open', name: p.name }),
          // Right-click: make sure the clicked photo is part of the selection first.
          oncontextmenu: () => {
            if (!selected.has(p.name)) {
              select(i, null);
            }
          },
          'data-vscode-context': photoContext(p.name),
          ondragstart: (e) => onDragStart(e, i),
        },
        h(
          'span',
          { class: 'thumb' },
          h('img', { class: 'thumb-img', alt: '', decoding: 'async', draggable: 'false' }),
          h('span', { class: 'thumb-label', 'aria-hidden': 'true' }, icon('photo', 20), p.ext || ''),
        ),
        h('span', { class: 'label' }, p.name),
      );
      tile.classList.toggle('edited', !!p.edited);
      tileByName.set(p.name, tile);
      applyThumb(tile, p.name);
      observer.observe(tile);
      return tile;
    });
    gridEl.append(...tiles);

    detailsEl = h('aside', { class: 'details', 'aria-label': 'Photo details' });
    renderDetails(undefined);

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
            h('div', { class: 'grow' }, crumbs(state.crumbs)),
            countEl,
            h('label', {}, 'Sort', sortSel),
            h('label', {}, 'Size', size),
            h('button', { class: 'icon-btn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => post({ type: 'refresh' }) }, icon('refresh')),
          ),
          photos.length ? gridEl : h('div', { class: 'message' }, 'No photos in this folder. Sub-folders are in the Photo Libraries tree.'),
        ),
        detailsEl,
      ),
    );
    paintSelection();
  }

  function onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && focusIndex >= 0) {
      post({ type: 'open', name: photos[focusIndex].name });
    } else if (e.key === 'ArrowRight') {
      moveFocus(1);
    } else if (e.key === 'ArrowLeft') {
      moveFocus(-1);
    } else if (e.key === 'ArrowDown') {
      moveFocus(columns());
    } else if (e.key === 'ArrowUp') {
      moveFocus(-columns());
    } else if (mod && e.key.toLowerCase() === 'a') {
      selected = new Set(photos.map((p) => p.name));
      paintSelection();
      sendSelection();
    } else if (e.key === 'Escape') {
      selected.clear();
      paintSelection();
      sendSelection();
    } else {
      return;
    }
    e.preventDefault();
  }

  function onDragStart(e, i) {
    if (!selected.has(photos[i].name)) {
      select(i, null);
    }
    const chosen = photos.filter((p) => selected.has(p.name));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/uri-list', chosen.map((p) => p.fileUri).join('\r\n'));
    e.dataTransfer.setData('text/plain', chosen.map((p) => p.path).join('\n'));
  }

  function renderDetails(d) {
    if (!d) {
      detailsEl.replaceChildren(section('details', 'DETAILS', h('p', { class: 'sub' }, 'Select a photo to see its details.')));
      return;
    }
    const known = thumbs.get(d.photo.name);
    const url = d.thumb ? blobUrl(d.thumb, 'image/webp') : known?.url;
    const preview = url
      ? h('img', { class: 'preview', src: url, alt: '', 'data-vscode-context': photoContext(d.photo.name) })
      : h('div', { class: 'preview raw-placeholder', 'aria-hidden': 'true' }, icon('photo', 22), d.photo.ext);
    detailsEl.replaceChildren(
      section(
        'details',
        'DETAILS',
        preview,
        h('div', {}, h('div', { class: 'name' }, d.photo.name), d.more > 0 ? h('div', { class: 'sub' }, `+ ${d.more} more selected`) : null),
        detailsList(d.rows),
        h('p', { class: 'hint-small' }, 'Double-click to open · right-click for Move to… and Reveal in OS'),
      ),
    );
  }


  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'init':
        render(m);
        break;
      case 'thumbs':
        receiveThumbs(m.items);
        break;
      case 'decode':
        void decode(m);
        break;
      case 'edited': {
        const tile = tileByName.get(m.name);
        tile?.classList.toggle('edited', !!m.edited);
        const ph = photos.find((p) => p.name === m.name);
        if (ph) {
          ph.edited = !!m.edited;
        }
        break;
      }
      case 'details':
        if (detailsEl) {
          renderDetails(m.details);
        }
        break;
      case 'visible':
        if (m.visible) {
          reportOnScreen();
        }
        break;
      case 'error':
        app.replaceChildren(h('div', { class: 'message' }, m.message));
        break;
    }
  });

  post({ type: 'ready' });
})();
