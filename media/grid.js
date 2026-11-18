// Library view: photo grid for one folder.
(function () {
  const { vscode, h, icon, crumbs, detailsList, picture, createLoader } = window.vsphoto;
  const loader = createLoader(4);
  const app = document.getElementById('app');

  let photos = [];
  let selected = new Set();
  let anchor = -1; // index for shift-click ranges
  let focusIndex = -1;
  let sort = 'name';
  let tileSize = (vscode.getState() || {}).tileSize || 160;
  let tiles = [];
  let gridEl, detailsEl, countEl;

  function post(msg) {
    vscode.postMessage(msg);
  }

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

  function render(state) {
    loader.reset();
    photos = state.photos;
    sort = state.sort;
    if (!(vscode.getState() || {}).tileSize && state.tileSize) {
      tileSize = state.tileSize;
    }
    selected = new Set((state.selected || []).filter((n) => photos.some((p) => p.name === n)));

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
      max: '320',
      step: '10',
      value: String(tileSize),
      'aria-label': 'Thumbnail size',
      oninput: (e) => {
        tileSize = Number(e.target.value);
        gridEl.style.setProperty('--tile', tileSize + 'px');
        vscode.setState({ tileSize });
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
    tiles = photos.map((p, i) =>
      h(
        'button',
        {
          class: 'tile',
          role: 'option',
          title: `${p.name}\nDouble-click to open in a new tab`,
          draggable: 'true',
          dataset: { i: String(i) },
          onclick: (e) => select(i, e),
          ondblclick: () => post({ type: 'open', name: p.name }),
          ondragstart: (e) => onDragStart(e, i),
        },
        h('span', { class: 'thumb' }, picture(p, 'thumb-img', loader)),
        h('span', { class: 'label' }, p.name),
      ),
    );
    gridEl.append(...tiles);

    detailsEl = h('aside', { class: 'details', 'aria-label': 'Photo details' }, h('h2', {}, 'DETAILS'), h('p', { class: 'sub' }, 'Select a photo to see its details.'));

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
      detailsEl.replaceChildren(h('h2', {}, 'DETAILS'), h('p', { class: 'sub' }, 'Select a photo to see its details.'));
      return;
    }
    const names = [...selected];
    detailsEl.replaceChildren(
      h('h2', {}, 'DETAILS'),
      picture(d.photo, 'preview', false),
      h('div', {}, h('div', { class: 'name' }, d.photo.name), d.more > 0 ? h('div', { class: 'sub' }, `+ ${d.more} more selected`) : null),
      detailsList(d.rows),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => post({ type: 'open', name: d.photo.name }) }, 'Open'),
        h('button', { class: 'btn', onclick: () => post({ type: 'move', names: names.length ? names : [d.photo.name] }) }, 'Move to…'),
        h('button', { class: 'btn', onclick: () => post({ type: 'reveal', name: d.photo.name }) }, 'Reveal in OS'),
      ),
    );
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'init') {
      render(m);
    } else if (m.type === 'details') {
      if (detailsEl) {
        renderDetails(m.details);
      }
    } else if (m.type === 'visible') {
      loader.setPaused(!m.visible);
    } else if (m.type === 'error') {
      app.replaceChildren(h('div', { class: 'message' }, m.message));
    }
  });

  post({ type: 'ready' });
})();
