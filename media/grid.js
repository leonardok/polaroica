// Library view: photo grid for one folder. Shows thumbnails only (never the originals): the
// extension sends cached ones, placeholders, and asks this page to decode + shrink the rest.
(function () {
  const { vscode, h, icon, crumbs, detailsList, blobUrl, makeThumbnail, section, photoContext, rankExplanation, keyBelongsToControl } = window.polaroica;
  const app = document.getElementById('app');

  let photos = [];
  let selected = new Set();
  let anchor = -1; // index for shift-click ranges
  let focusIndex = -1;
  let sort = 'name';
  let tileSize = (vscode.getState() || {}).tileSize || 160;
  /** Culling view: which photos show. Remembered per tab. */
  let view = Object.assign({ filter: 'all', hideRejects: false, minStars: 0, stack: true }, (vscode.getState() || {}).view || {});
  let filterBarEl, lastDetails;
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
    let next = Math.max(0, Math.min(photos.length - 1, (focusIndex < 0 ? 0 : focusIndex) + delta));
    const dir = delta < 0 ? -1 : 1;
    while (tiles[next] && tiles[next].hidden) next += dir; // skip filtered-out photos
    if (!tiles[next]) return;
    tiles[next].focus();
    tiles[next].scrollIntoView({ block: 'nearest' });
    select(next, null);
  }

  /** Justified grid: each tile is as wide as its photo's shape at the row height (see grid.css). */
  function setRatio(tile, r) {
    if (!(r > 0.2 && r < 6)) return;
    const v = String(Math.round(r * 1000) / 1000);
    if (tile.style.getPropertyValue('--r') !== v) tile.style.setProperty('--r', v);
  }

  /** Up/Down: the photo in the row above/below whose middle is closest (rows have no fixed columns). */
  function moveVertical(dir) {
    const cur = tiles[focusIndex < 0 ? 0 : focusIndex];
    if (!cur) return;
    const a = cur.getBoundingClientRect();
    const mid = a.left + a.width / 2;
    let best = -1;
    let bestRow = Infinity;
    let bestDx = Infinity;
    tiles.forEach((t, i) => {
      if (t.hidden) return;
      const b = t.getBoundingClientRect();
      const rowGap = dir > 0 ? b.top - a.bottom : a.top - b.bottom;
      if (rowGap < -1) return; // same row or the wrong way
      const dx = Math.abs(b.left + b.width / 2 - mid);
      // Nearest row first, then the closest photo in it.
      if (rowGap < bestRow - 1 || (Math.abs(rowGap - bestRow) <= 1 && dx < bestDx)) {
        best = i;
        bestRow = rowGap;
        bestDx = dx;
      }
    });
    if (best >= 0) moveFocus(best - (focusIndex < 0 ? 0 : focusIndex));
  }

  // ---- culling ----------------------------------------------------------------------

  const SPARK = () => {
    const el = icon('spark', 10);
    el.setAttribute('fill', 'currentColor');
    el.setAttribute('stroke', 'none');
    el.classList.add('spark');
    return el;
  };

  function saveView() {
    vscode.setState({ ...(vscode.getState() || {}), view });
  }

  /** Is this photo shown under the current filter / stacking? */
  function visible(p) {
    const c = p.cull || {};
    if (view.hideRejects && c.flag === 'reject') return false;
    if ((c.rating || 0) < view.minStars) return false;
    if (view.filter === 'picks' && c.flag !== 'pick') return false;
    if (view.filter === 'rejects' && c.flag !== 'reject') return false;
    if (view.filter === 'unflagged' && c.flag) return false;
    const g = c.auto && c.auto.group;
    if (view.stack && g && g.size > 1 && !g.best) return false;
    return true;
  }

  function paintTile(tile, p) {
    const c = p.cull || {};
    tile.classList.toggle('edited', !!c.edited);
    tile.classList.toggle('is-reject', c.flag === 'reject');
    const badges = tile.querySelector('.badges');
    const kids = [];
    if (c.flag === 'pick') kids.push(h('span', { class: 'flag pick', title: 'Pick' }, icon('check', 12)));
    if (c.flag === 'reject') kids.push(h('span', { class: 'flag reject', title: 'Rejected' }, icon('x', 12)));
    const g = c.auto && c.auto.group;
    if (view.stack && g && g.size > 1 && g.best) {
      kids.push(h('span', { class: 'stack-badge' }, `Best of ${g.size}`));
      tile.classList.add('stacked');
    } else {
      tile.classList.remove('stacked');
    }
    if (c.rating) {
      kids.push(h('span', { class: 'stars', title: `${c.rating} star${c.rating > 1 ? 's' : ''}${c.auto ? ' (Auto-Rank)' : ''}` }, '★'.repeat(c.rating), c.auto ? SPARK() : null));
    }
    badges.replaceChildren(...kids);
  }

  function applyFilter() {
    tiles.forEach((t, i) => {
      t.hidden = !visible(photos[i]);
    });
    paintFilterBar();
  }

  function counts() {
    const n = { all: photos.length, picks: 0, rejects: 0, unflagged: 0, groups: 0 };
    for (const p of photos) {
      const f = p.cull && p.cull.flag;
      if (f === 'pick') n.picks++;
      else if (f === 'reject') n.rejects++;
      else n.unflagged++;
      if (p.cull && p.cull.auto && p.cull.auto.group && p.cull.auto.group.best && p.cull.auto.group.size > 1) n.groups++;
    }
    return n;
  }

  function paintFilterBar() {
    if (!filterBarEl) return;
    const n = counts();
    const seg = h(
      'div',
      { class: 'segmented', role: 'radiogroup', 'aria-label': 'Show' },
      [['all', 'All'], ['picks', 'Picks'], ['unflagged', 'Unflagged'], ['rejects', 'Rejects']].map(([id, label]) =>
        h(
          'button',
          {
            class: 'seg' + (view.filter === id ? ' on' : ''),
            role: 'radio',
            'aria-checked': String(view.filter === id),
            onclick: () => {
              view.filter = id;
              saveView();
              applyFilter();
            },
          },
          label,
          h('span', { class: 'seg-count' }, String(n[id])),
        ),
      ),
    );
    const hide = h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: view.hideRejects, onchange: (e) => { view.hideRejects = e.target.checked; saveView(); applyFilter(); } }), 'Hide rejects');
    const starsSel = h(
      'select',
      { 'aria-label': 'Minimum stars', onchange: (e) => { view.minStars = Number(e.target.value); saveView(); applyFilter(); } },
      [0, 1, 2, 3, 4, 5].map((k) => h('option', { value: String(k), selected: view.minStars === k }, k === 0 ? 'Any' : k === 5 ? '★ 5' : `★ ${k}+`)),
    );
    const stack = n.groups
      ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: view.stack, onchange: (e) => { view.stack = e.target.checked; saveView(); tiles.forEach((t, i) => paintTile(t, photos[i])); applyFilter(); } }), 'Stack similar shots')
      : null;
    filterBarEl.replaceChildren(
      seg,
      hide,
      h('label', {}, 'Stars', starsSel),
      stack,
      h('span', { class: 'grow' }),
      h('span', { class: 'key-hint' }, 'P pick · X reject · U clear · 0–5 stars'),
      h('button', { class: 'btn', title: 'Rate this album automatically (focus, exposure, similar shots)', onclick: () => post({ type: 'autoRank' }) }, icon('spark', 12), ' Auto-Rank…'),
    );
  }

  /** P / X / U / 0–5 on the selection (or the focused photo). */
  function rate(change) {
    const names = selected.size ? [...selected] : focusIndex >= 0 ? [photos[focusIndex].name] : [];
    if (!names.length) return;
    for (const name of names) {
      const p = photos.find((x) => x.name === name);
      if (!p) continue;
      const c = Object.assign({ rating: 0, edited: false }, p.cull || {});
      if ('rating' in change) c.rating = change.rating;
      if ('flag' in change) c.flag = change.flag || undefined;
      delete c.auto; // your rating replaces Auto-Rank's
      p.cull = c;
      const t = tileByName.get(name);
      if (t) paintTile(t, p);
    }
    post({ type: 'rate', names, ...change });
    applyFilter();
    // The photo just flagged may now be hidden by a filter: move on to the next one shown.
    if (focusIndex >= 0 && tiles[focusIndex] && tiles[focusIndex].hidden) {
      let next = focusIndex + 1;
      while (tiles[next] && tiles[next].hidden) next++;
      if (!tiles[next]) {
        next = focusIndex - 1;
        while (tiles[next] && tiles[next].hidden) next--;
      }
      if (tiles[next]) {
        select(next, null);
        tiles[next].focus();
        tiles[next].scrollIntoView({ block: 'nearest' });
      }
    }
    if (lastDetails) renderDetails(lastDetails);
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
          h('img', {
            class: 'thumb-img',
            alt: '',
            decoding: 'async',
            draggable: 'false',
            // The real shape once a thumbnail shows (photos the index had no size for yet).
            onload: (e) => setRatio(tile, e.target.naturalWidth / e.target.naturalHeight),
          }),
          h('span', { class: 'thumb-label', 'aria-hidden': 'true' }, icon('photo', 20), p.ext || ''),
          h('span', { class: 'badges' }),
        ),
        h('span', { class: 'label' }, p.name),
      );
      setRatio(tile, p.ratio || 1.5);
      paintTile(tile, p);
      tileByName.set(p.name, tile);
      applyThumb(tile, p.name);
      observer.observe(tile);
      return tile;
    });
    gridEl.append(...tiles);
    filterBarEl = h('div', { class: 'filterbar' });

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
          photos.length ? filterBarEl : null,
          photos.length ? gridEl : h('div', { class: 'message' }, 'No photos in this folder. Sub-folders are in the Polaroica sidebar.'),
        ),
        detailsEl,
      ),
    );
    paintSelection();
    applyFilter();
  }

  function onKey(e) {
    if (keyBelongsToControl(e)) {
      return;
    }
    if (e.defaultPrevented) {
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && focusIndex >= 0) {
      post({ type: 'open', name: photos[focusIndex].name });
    } else if (e.key === 'ArrowRight') {
      moveFocus(1);
    } else if (e.key === 'ArrowLeft') {
      moveFocus(-1);
    } else if (e.key === 'ArrowDown') {
      moveVertical(1);
    } else if (e.key === 'ArrowUp') {
      moveVertical(-1);
    } else if (mod && e.key.toLowerCase() === 'a') {
      selected = new Set(photos.map((p) => p.name));
      paintSelection();
      sendSelection();
    } else if (!mod && (e.key === 'p' || e.key === 'P')) {
      rate({ flag: 'pick' });
    } else if (!mod && (e.key === 'x' || e.key === 'X')) {
      rate({ flag: 'reject' });
    } else if (!mod && (e.key === 'u' || e.key === 'U')) {
      rate({ flag: null });
    } else if (!mod && /^[0-5]$/.test(e.key)) {
      rate({ rating: Number(e.key) });
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
    lastDetails = d;
    if (!d) {
      detailsEl.replaceChildren(section('details', 'DETAILS', h('p', { class: 'sub' }, 'Select a photo to see its details.')));
      return;
    }
    const p = photos.find((x) => x.name === d.photo.name);
    const c = (p && p.cull) || {};
    const known = thumbs.get(d.photo.name);
    const url = d.thumb ? blobUrl(d.thumb, 'image/webp') : known?.url;
    const preview = url
      ? h('img', { class: 'preview', src: url, alt: '', 'data-vscode-context': photoContext(d.photo.name) })
      : h('div', { class: 'preview raw-placeholder', 'aria-hidden': 'true' }, icon('photo', 22), d.photo.ext);
    const ratingBlock = h(
      'div',
      { class: 'rating' },
      h('div', { class: 'rating-title' }, 'RATING'),
      h(
        'div',
        { class: 'flags' },
        h('button', { class: 'flag-btn' + (c.flag === 'pick' ? ' pick' : ''), 'aria-pressed': String(c.flag === 'pick'), title: 'Pick (P)', onclick: () => rate({ flag: c.flag === 'pick' ? null : 'pick' }) }, icon('check', 12), 'Pick'),
        h('button', { class: 'flag-btn' + (c.flag === 'reject' ? ' reject' : ''), 'aria-pressed': String(c.flag === 'reject'), title: 'Reject (X)', onclick: () => rate({ flag: c.flag === 'reject' ? null : 'reject' }) }, icon('x', 12), 'Reject'),
        c.auto ? h('span', { class: 'auto-mark', title: 'Rated by Auto-Rank' }, SPARK(), 'Auto-Rank') : null,
      ),
      h(
        'div',
        { class: 'star-row', role: 'radiogroup', 'aria-label': 'Stars' },
        [1, 2, 3, 4, 5].map((k) =>
          h('button', { class: 'star' + (k <= (c.rating || 0) ? ' on' : ''), role: 'radio', 'aria-checked': String(c.rating === k), 'aria-label': `${k} star${k > 1 ? 's' : ''}`, title: `${k} (key ${k})`, onclick: () => rate({ rating: c.rating === k ? 0 : k }) }, '★'),
        ),
      ),
      h('p', { class: 'hint-small' }, d.more > 0 ? `Applies to all ${d.more + 1} selected` : 'Saved next to the photo in .sidecar/'),
    );
    const sections = [
      section(
        'details',
        'DETAILS',
        preview,
        h('div', {}, h('div', { class: 'name' }, d.photo.name), d.more > 0 ? h('div', { class: 'sub' }, `+ ${d.more} more selected`) : null),
        ratingBlock,
        detailsList(d.rows),
        h('p', { class: 'hint-small' }, 'Double-click to open · right-click for Move to… and Reveal in OS'),
      ),
    ];
    if (c.auto) {
      sections.push(autoRankSection(d.photo.name, c.auto));
    }
    detailsEl.replaceChildren(...sections);
  }

  function autoRankSection(name, auto) {
    const g = auto.group;
    const members = g && g.size > 1 ? photos.filter((p) => p.cull && p.cull.auto && p.cull.auto.group && p.cull.auto.group.id === g.id) : [];
    const summary = h('span', { class: 'section-summary' }, SPARK(), g && g.size > 1 ? (g.best ? ` best of ${g.size}` : g.kept ? ` kept · 1 of ${g.size} similar` : ` 1 of ${g.size} similar`) : ' ranked');
    return section(
      'autorank',
      h('span', { class: 'section-title' }, 'AUTO-RANK', summary),
      rankExplanation(auto),
      members.length
        ? h(
            'div',
            { class: 'group' },
            h('div', { class: 'rating-title' }, `SIMILAR SHOTS (${members.length})`),
            h(
              'div',
              { class: 'group-strip' },
              members.map((p) => {
                const t = thumbs.get(p.name);
                const best = p.cull.auto.group.best;
                return h(
                  'button',
                  {
                    class: 'group-item' + (best ? ' best' : '') + (p.name === name ? ' current' : ''),
                    title: `${p.name}${best ? ' (best)' : ''}: focus ${Math.round((p.cull.auto.scores || {}).focus || 0)}. Click to make it the best of this group.`,
                    onclick: () => post({ type: 'makeBest', name: p.name }),
                  },
                  t ? h('img', { src: t.url, alt: '' }) : null,
                );
              }),
            ),
            h('p', { class: 'hint-small' }, 'Click a shot to make it the group’s best instead.'),
          )
        : null,
    );
  }



  // Grid keys work wherever focus is in the tab (e.g. after a flagged photo was filtered away).
  window.addEventListener('keydown', (e) => {
    if (gridEl && !gridEl.contains(e.target)) onKey(e);
  });

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
      case 'cull': {
        const p = photos.find((x) => x.name === m.name);
        if (p) {
          p.cull = m.cull || null;
          const t = tileByName.get(m.name);
          if (t) paintTile(t, p);
          applyFilter();
          if (lastDetails && lastDetails.photo.name === m.name) renderDetails(lastDetails);
        }
        break;
      }
      case 'faces':
        window.polaroica.faces
          .detect(window.polaroica.bytes(m.data), m.width, m.height, m.runtime, m.models)
          .then((faces) => post({ type: 'facesResult', id: m.id, faces }))
          .catch((err) => post({ type: 'facesResult', id: m.id, error: String((err && err.message) || err) }));
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
