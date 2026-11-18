// Photo tab: one photo at full view; ← → browse the folder in this tab.
// The cached thumbnail shows at once, scaled up, while the original streams in from the share.
(function () {
  const { vscode, h, icon, crumbs, detailsList, blobUrl } = window.vsphoto;
  const app = document.getElementById('app');
  let zoom = (vscode.getState() || {}).zoom || 'fit';
  let detailsEl, frameEl, noteEl, current;
  let urls = []; // object URLs of the current render, revoked on the next
  let preloads = []; // keep references so the browser doesn't cancel them

  const post = (msg) => vscode.postMessage(msg);
  const track = (u) => (urls.push(u), u);

  function render(m) {
    urls.forEach((u) => URL.revokeObjectURL(u));
    urls = [];
    current = m;

    const fitBtn = h('button', { class: 'btn' + (zoom === 'fit' ? ' on' : ''), 'aria-pressed': String(zoom === 'fit'), onclick: () => setZoom('fit') }, 'Fit');
    const fullBtn = h('button', { class: 'btn' + (zoom === 'full' ? ' on' : ''), 'aria-pressed': String(zoom === 'full'), onclick: () => setZoom('full') }, '100%');

    noteEl = h('div', { class: 'loading', role: 'status' }, 'Loading photo…');
    frameEl = h('div', { class: 'frame ' + zoom, ondblclick: () => post({ type: 'grid' }), title: 'Double-click to go back to the grid' });
    if (m.thumb) {
      frameEl.append(h('img', { class: 'photo standin' + (m.thumbQuick ? ' soft' : ''), src: track(blobUrl(m.thumb, 'image/webp')), alt: '' }));
    }
    if (m.photo.src) {
      showMain(m.photo.src, m.photo.name);
    } else if (!m.waitForPreview) {
      frameEl.append(h('div', { class: 'photo raw-placeholder', role: 'img', 'aria-label': m.photo.name }, icon('photo', 22), m.photo.ext, h('span', { class: 'raw-note' }, 'Preview for this format is not supported yet')));
      noteEl.remove();
    }
    frameEl.append(noteEl);

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
          s.thumb
            ? h('img', { class: 'strip-img', src: track(blobUrl(s.thumb, 'image/webp')), alt: '' })
            : h('div', { class: 'strip-img raw-placeholder' }, s.ext),
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
            frameEl,
            h('button', { class: 'nav', 'aria-label': 'Next photo (→)', title: 'Next (→)', onclick: () => post({ type: 'step', delta: 1 }) }, icon('right', 18)),
          ),
          h('footer', { class: 'film' }, strip, h('p', { class: 'hint' }, '← → previous / next · double-click the photo to go back to the grid')),
        ),
        detailsEl,
      ),
    );
    strip.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  /** Puts the full photo on top of the stand-in; preloads neighbours once it's in. */
  function showMain(src, name) {
    const for_ = current;
    const img = h('img', { class: 'photo main', alt: name, decoding: 'async' });
    img.addEventListener('load', async () => {
      // Swap only once the big photo is decoded, so the stand-in never blinks away early.
      await img.decode().catch(() => undefined);
      if (current !== for_) {
        return;
      }
      img.classList.add('ready');
      frameEl.querySelector('.standin')?.remove();
      noteEl.remove();
      preloads = (for_.preload || []).map((u) => {
        const p = new Image();
        p.decoding = 'async';
        p.src = u;
        return p;
      });
    });
    img.addEventListener('error', () => {
      if (current === for_) {
        noteEl.textContent = 'Could not load this photo.';
      }
    });
    img.src = src;
    frameEl.insertBefore(img, noteEl.parentNode === frameEl ? noteEl : null);
  }

  function setZoom(z) {
    zoom = z;
    vscode.setState({ zoom });
    if (frameEl) {
      frameEl.classList.toggle('fit', z === 'fit');
      frameEl.classList.toggle('full', z === 'full');
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
        // RAW: the JPEG preview embedded in the file.
        if (current && current.photo.name === m.name) {
          if (m.data) {
            showMain(track(blobUrl(m.data, 'image/jpeg')), m.name);
          } else {
            noteEl.textContent = 'This RAW file has no preview we can show.';
          }
        }
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

  post({ type: 'ready' });
})();
