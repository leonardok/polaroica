// Photo tab: one photo at full view; ← → browse the folder in this tab.
(function () {
  const { vscode, h, icon, crumbs, detailsList, picture, createLoader } = window.vsphoto;
  let stripLoader;
  const app = document.getElementById('app');
  let zoom = (vscode.getState() || {}).zoom || 'fit';
  let detailsEl;

  const post = (msg) => vscode.postMessage(msg);

  function render(m) {
    const fitBtn = h('button', { class: 'btn' + (zoom === 'fit' ? ' on' : ''), 'aria-pressed': String(zoom === 'fit'), onclick: () => setZoom('fit') }, 'Fit');
    const fullBtn = h('button', { class: 'btn' + (zoom === 'full' ? ' on' : ''), 'aria-pressed': String(zoom === 'full'), onclick: () => setZoom('full') }, '100%');

    if (stripLoader) {
      stripLoader.reset();
    }
    // Filmstrip neighbours wait until the main photo is in, then load two at a time.
    stripLoader = createLoader(2);
    stripLoader.setPaused(true);
    const img = picture(m.photo, 'photo', null);
    img.addEventListener('dblclick', () => post({ type: 'grid' }));
    const loadingNote = h('div', { class: 'loading', role: 'status' }, 'Loading photo…');
    if (img.tagName === 'IMG') {
      const done = () => {
        loadingNote.remove();
        stripLoader.setPaused(false);
      };
      img.addEventListener('load', done);
      img.addEventListener('error', () => {
        loadingNote.textContent = 'Could not load this photo.';
        stripLoader.setPaused(false);
      });
    } else {
      loadingNote.remove();
      stripLoader.setPaused(false);
    }
    img.title = 'Double-click to go back to the grid';
    if (m.photo.raw || !m.photo.src) {
      img.append(h('span', { class: 'raw-note' }, 'Preview for this format is not supported yet'));
    }

    const strip = h(
      'div',
      { class: 'strip', role: 'list', 'aria-label': 'Nearby photos' },
      m.strip.map((s) =>
        h(
          'button',
          {
            class: 'strip-item' + (s.index === m.index ? ' current' : ''),
            'aria-label': s.name,
            'aria-current': s.index === m.index ? 'true' : undefined,
            title: s.name,
            onclick: () => post({ type: 'goto', index: s.index }),
          },
          picture(s, 'strip-img', stripLoader),
        ),
      ),
    );

    detailsEl = h('aside', { class: 'details', 'aria-label': 'Photo details' }, h('h2', {}, 'DETAILS'), h('div', { class: 'name' }, m.photo.name));

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
            h('div', { class: 'zoom' }, fitBtn, fullBtn),
          ),
          h(
            'div',
            { class: 'stage' },
            h('button', { class: 'nav', 'aria-label': 'Previous photo (←)', title: 'Previous (←)', onclick: () => post({ type: 'step', delta: -1 }) }, icon('left', 18)),
            h('div', { class: 'frame ' + zoom }, img, loadingNote),
            h('button', { class: 'nav', 'aria-label': 'Next photo (→)', title: 'Next (→)', onclick: () => post({ type: 'step', delta: 1 }) }, icon('right', 18)),
          ),
          h('footer', { class: 'film' }, strip, h('p', { class: 'hint' }, '← → previous / next · double-click the photo to go back to the grid')),
        ),
        detailsEl,
      ),
    );
    strip.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function setZoom(z) {
    zoom = z;
    vscode.setState({ zoom });
    const frame = document.querySelector('.frame');
    if (frame) {
      frame.classList.toggle('fit', z === 'fit');
      frame.classList.toggle('full', z === 'full');
    }
    document.querySelectorAll('.zoom .btn').forEach((b, i) => {
      const on = (i === 0) === (z === 'fit');
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }

  function renderDetails(rows) {
    if (!detailsEl) {
      return;
    }
    const name = detailsEl.querySelector('.name')?.textContent || '';
    detailsEl.replaceChildren(
      h('h2', {}, 'DETAILS'),
      h('div', { class: 'name' }, name),
      detailsList(rows),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', onclick: () => post({ type: 'reveal' }) }, 'Reveal in OS'),
        h('button', { class: 'btn', onclick: () => post({ type: 'move' }) }, 'Move to…'),
      ),
    );
  }

  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      return;
    }
    if (e.key === 'ArrowLeft') {
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

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'show') {
      render(m);
    } else if (m.type === 'details') {
      renderDetails(m.rows);
    } else if (m.type === 'empty') {
      app.replaceChildren(h('div', { class: 'message' }, 'This folder has no photos any more.'));
    } else if (m.type === 'error') {
      app.replaceChildren(h('div', { class: 'message' }, m.message));
    }
  });

  post({ type: 'ready' });
})();
