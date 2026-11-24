import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore, sortSetting } from './photoStore';
import { FolderSource, GridPhoto, PhotoSource } from './photoSource';
import { Thumb } from './core/cache';
import { JobPhoto, ThumbJob, ThumbService } from './thumbs';
import { EditStore } from './edits';
import { PhotoExporter } from './export';
import { DETAILS_WIDTH, fromWire, localRoots, post, webviewHtml } from './webview';
import * as fs from 'fs';
import { FaceModels } from './faceModel';
import { RankTarget } from './autorank';
import { FaceMetric } from './core/rank';
import { Rgba } from './core/image';

type FromGrid =
  | { type: 'ready' }
  | { type: 'open'; name: string }
  | { type: 'select'; names: string[]; focus?: string }
  | { type: 'move'; names: string[] }
  | { type: 'reveal'; name: string }
  | { type: 'sort'; key: SortKey }
  | { type: 'tileSize'; size: number }
  | { type: 'rate'; names: string[]; rating?: number; flag?: 'pick' | 'reject' | null }
  | { type: 'autoRank' }
  | { type: 'undoAutoRank' }
  | { type: 'deleteRejected' }
  | { type: 'export' }
  | { type: 'makeBest'; name: string }
  | { type: 'facesResult'; id: number; faces?: FaceMetric[]; error?: string }
  | { type: 'onscreen'; names: string[] }
  | { type: 'decoded'; id: number; data?: unknown; w?: number; h?: number }
  | { type: 'detailsWidth'; width: number }
  | { type: 'refresh' };

export interface GridHost {
  openPhoto(folder: vscode.Uri, name: string, sort: SortKey): void;
  /** Auto-Rank works on the album's photos, wherever they live. */
  autoRank?(album: RankTarget): void;
  undoAutoRank?(key: string): void;
  makeBest?(photo: vscode.Uri, album: vscode.Uri[]): void;
  deleteRejected?(folder: vscode.Uri): void;
  /** A tag album spans folders: its rejects are picked out of the album's own photos. */
  deleteRejectedAmong?(photos: vscode.Uri[], where: string): void;
  exportPhotos?(folder: vscode.Uri, selected: string[]): void;
}

/** One editor tab per folder showing its photos as a grid (the library view). */
export class GridPanels implements vscode.Disposable {
  private readonly panels = new Map<string, GridPanel>();
  private readonly status: vscode.StatusBarItem;
  private host?: GridHost;
  /** Export (right-click → Export…), set by the extension. */
  exporter?: PhotoExporter;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly mover: Mover,
    private readonly thumbs: ThumbService,
    private readonly edits?: EditStore,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    context.subscriptions.push(
      store.onDidChange((folder) => {
        for (const p of this.panels.values()) {
          if (!folder || p.covers(folder)) {
            void p.reload();
          }
        }
      }),
      ...(edits
        ? [
            edits.onDidChange((photo) => {
              for (const grid of this.panels.values()) {
                const key = grid.keyOf(photo);
                if (!key) {
                  continue;
                }
                const name = path.basename(photo.fsPath);
                void edits.cullingIn(path.dirname(photo.fsPath)).then((map) => {
                  post(grid.panel.webview, { type: 'cull', name: key, cull: map.get(name) ?? null });
                  grid.cull.set(key, map.get(name));
                  this.updateStatus();
                });
              }
            }),
          ]
        : []),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        for (const p of this.panels.values()) {
          p.panel.webview.options = { ...p.panel.webview.options, localResourceRoots: localRoots(context.extensionUri) };
        }
      }),
    );
  }

  /** Delete Rejects from the grid's context menu: the grid in front, never the sidebar selection. */
  deleteRejectedInActive(): boolean {
    const active = [...this.panels.values()].find((p) => p.panel.active);
    active?.deleteRejected();
    return !!active;
  }

  setHost(host: GridHost): void {
    this.host = host;
  }

  /** Set by the extension: an album was opened (or brought back to the front). */
  onOpen?: (folder: vscode.Uri) => void;

  /** Opens a folder's grid (the Libraries tree, and opening a photo's album). */
  open(folder: vscode.Uri): void {
    this.onOpen?.(folder);
    this.openSource(new FolderSource(folder, this.store, this.libraries));
  }

  /** Opens any grid: a folder, or every photo carrying a tag. */
  openSource(source: PhotoSource): void {
    const existing = this.panels.get(source.id);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'polaroica.grid',
      source.title,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: localRoots(this.context.extensionUri) },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'grid-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'grid-dark.svg'),
    };
    const grid = new GridPanel(panel, source, this);
    this.panels.set(source.id, grid);
    panel.onDidDispose(() => {
      grid.dispose();
      this.panels.delete(source.id);
      this.updateStatus();
    });
    panel.onDidChangeViewState((e) => {
      this.updateStatus();
      // Stop pulling photos over the network while the grid is not on screen.
      void post(panel.webview, { type: 'visible', visible: e.webviewPanel.visible });
      if (e.webviewPanel.visible) {
        grid.job.resume();
      }
    });
  }

  /** Right-click menu on a photo in the active grid: acts on the selection when it holds the photo. */
  async contextAction(action: 'move' | 'reveal' | 'export' | 'copyPath', name: string | undefined): Promise<void> {
    const grid = [...this.panels.values()].find((p) => p.panel.active);
    if (!grid || !name) {
      return;
    }
    const target = grid.uriOf(name);
    if (!target) {
      return;
    }
    const keys = grid.selected.includes(name) ? grid.selected : [name];
    const uris = keys.map((k) => grid.uriOf(k)).filter((u): u is vscode.Uri => !!u);
    if (action === 'reveal') {
      await vscode.commands.executeCommand('revealFileInOS', target);
    } else if (action === 'copyPath') {
      await vscode.env.clipboard.writeText(target.fsPath);
    } else if (action === 'export') {
      // A tag album spans folders: fall back to the photo's own folder as the export base.
      await this.exporter?.exportPhotos(uris, grid.source.folder ?? vscode.Uri.file(path.dirname(target.fsPath)));
    } else {
      await this.mover.moveWithPicker(uris);
    }
  }

  /**
   * The photos a right-click in the active grid acts on: the selection when it holds the clicked
   * photo, else just that one. Empty when no grid is in front.
   */
  selectionFor(name: string | undefined): vscode.Uri[] {
    const grid = [...this.panels.values()].find((p) => p.panel.active);
    if (!grid || !name) {
      return [];
    }
    const keys = grid.selected.includes(name) ? grid.selected : [name];
    return keys.map((k) => grid.uriOf(k)).filter((u): u is vscode.Uri => !!u);
  }

  /** Face metrics for a photo, via the grid tab of its folder (opened if needed). */
  async detectFaces(target: RankTarget, pixels: Rgba, models: FaceModels): Promise<{ faces?: FaceMetric[]; error?: string }> {
    // The album's own tab runs the model. A run started from the sidebar has no tab open yet, and
    // only a folder album can be opened from a path.
    if (!this.panels.get(target.key) && target.folder) {
      this.open(target.folder);
    }
    const grid = this.panels.get(target.key);
    return grid ? grid.detectFaces(pixels, models) : { error: 'the grid tab could not be opened' };
  }

  /**
   * Tags changed: re-read every open tag album, since which photos belong in it has changed. A
   * folder album is unaffected — its contents don't depend on tags.
   */
  reloadTagGrids(): void {
    for (const p of this.panels.values()) {
      if (p.source.kind === 'tag') {
        void p.reload();
      }
    }
  }

  /** A thumbnail made by the background builder: show it in any open grid holding that photo. */
  offer(photo: Photo, t: Thumb): void {
    for (const grid of this.panels.values()) {
      grid.job.offer(photo, t);
    }
  }

  /** Forget panels for a folder that was moved away; reload tag albums that showed its photos. */
  closeFor(folder: vscode.Uri): void {
    for (const p of [...this.panels.values()]) {
      const own = p.source.folder?.fsPath;
      if (own && (own === folder.fsPath || own.startsWith(folder.fsPath + path.sep))) {
        p.panel.dispose();
      } else if (p.source.kind === 'tag') {
        void p.reload();
      }
    }
  }

  updateStatus(): void {
    const active = [...this.panels.values()].find((p) => p.panel.active);
    if (!active) {
      this.status.hide();
      return;
    }
    const ref = active.source.folder ?? active.photos[0]?.photo.uri;
    const lib = ref && this.libraries.libraryOf(ref);
    const n = active.photos.length;
    const sel = active.selected.length;
    let picks = 0;
    let rejects = 0;
    for (const p of active.photos) {
      const c = active.cull.get(p.key);
      if (c?.flag === 'pick') picks++;
      else if (c?.flag === 'reject') rejects++;
    }
    const icon = active.source.kind === 'tag' ? 'tag' : lib && this.libraries.kind(lib) === 'smb' ? 'server' : 'device-desktop';
    this.status.text =
      `$(${icon}) ${n.toLocaleString()} photo${n === 1 ? '' : 's'}` +
      (picks ? ` · ${picks} picks` : '') +
      (rejects ? ` · ${rejects} rejects` : '') +
      (sel ? ` · ${sel} selected` : '');
    this.status.tooltip = active.source.folder?.fsPath ?? `Photos tagged ${active.source.title}`;
    this.status.show();
  }

  // shared by panels
  get ctx() {
    return { context: this.context, libraries: this.libraries, store: this.store, mover: this.mover, host: this.host, thumbs: this.thumbs, edits: this.edits };
  }

  dispose(): void {
    for (const p of this.panels.values()) {
      p.panel.dispose();
    }
    this.status.dispose();
  }
}

class GridPanel {
  photos: GridPhoto[] = [];
  /** Keys of the selected photos. */
  selected: string[] = [];
  /** Ratings and flags of the grid's photos, by key (for the status bar). */
  cull = new Map<string, import('./edits').CullInfo | undefined>();
  /** key -> photo, for everything the webview asks about. */
  private byKey = new Map<string, GridPhoto>();
  private sort: SortKey = sortSetting();
  private focus?: string;
  readonly job: ThumbJob;
  private nextId = 1;
  private readonly pending = new Map<number, (t: Thumb | undefined) => void>();
  private readonly pendingFaces = new Map<number, (r: { faces?: FaceMetric[]; error?: string }) => void>();
  /** The face models handed to the page (once per tab, as bytes: see detectFaces). */
  private modelsSent?: Promise<void>;
  private markReady!: () => void;
  /** Resolves once the page's script listens for messages. */
  private readonly ready = new Promise<void>((r) => (this.markReady = r));

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly source: PhotoSource,
    private readonly owner: GridPanels,
  ) {
    const { context } = owner.ctx;
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: source.title,
      script: ['faces.js', 'grid.js'],
      style: 'grid.css',
      body: '<div id="app"></div>',
      faces: true,
    });
    panel.webview.onDidReceiveMessage((m: FromGrid) => this.onMessage(m));
    this.job = owner.ctx.thumbs.job({
      send: (items) => void post(panel.webview, { type: 'thumbs', items }),
      decode: (name, data, mime, px) =>
        new Promise<Thumb | undefined>((resolve) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            resolve(undefined);
          }, 60000);
          this.pending.set(id, (t) => {
            clearTimeout(timer);
            resolve(t);
          });
          void post(panel.webview, { type: 'decode', id, name, mime, px, data });
        }),
      get active() {
        return panel.visible;
      },
    });
  }

  /** The photo a key names, when this grid still holds it. */
  uriOf(key: string): vscode.Uri | undefined {
    return this.byKey.get(key)?.photo.uri;
  }

  /** The key this grid knows a photo by, when it holds it. */
  keyOf(photo: vscode.Uri): string | undefined {
    for (const p of this.photos) {
      if (p.photo.uri.fsPath === photo.fsPath) {
        return p.key;
      }
    }
    return undefined;
  }

  /** True when a change to `folder` could change what this grid shows. */
  /** This grid as an album Auto-Rank can work on: its photos, from however many folders. */
  rankTarget(): RankTarget {
    return {
      key: this.source.id,
      title: this.source.title,
      photos: this.photos.map((p) => p.photo),
      folder: this.source.folder,
    };
  }

  /** Delete Rejects for this grid: its folder's rejects, or a tag album's own rejected photos. */
  deleteRejected(): void {
    const { host } = this.owner.ctx;
    const own = this.source.folder;
    if (own) {
      host?.deleteRejected?.(own);
    } else {
      host?.deleteRejectedAmong?.(this.photos.map((p) => p.photo.uri), this.source.title);
    }
  }

  covers(folder: vscode.Uri): boolean {
    if (this.source.folder) {
      return this.source.folder.fsPath === folder.fsPath;
    }
    return this.photos.some((p) => path.dirname(p.photo.uri.fsPath) === folder.fsPath);
  }

  /** Runs the face model on a photo in this tab (MediaPipe needs a browser page). */
  async detectFaces(pixels: Rgba, models: FaceModels): Promise<{ faces?: FaceMetric[]; error?: string }> {
    await this.ready;
    // The models go to the page as bytes. Letting the page fetch them from the extension's
    // storage folder is refused by some VS Code builds (401) even when that folder is allowed.
    // Several photos arrive at once: only the first carries the models, and the others are sent
    // after it (messages reach the page in order).
    let modelBytes: { landmarker: Uint8Array; detector: Uint8Array } | undefined;
    if (!this.modelsSent) {
      let markSent!: () => void;
      this.modelsSent = new Promise<void>((r) => (markSent = r));
      try {
        const [landmarker, detector] = await Promise.all([fs.promises.readFile(models.landmarker), fs.promises.readFile(models.detector)]);
        modelBytes = { landmarker, detector };
      } catch (err) {
        this.modelsSent = undefined;
        markSent();
        return { error: `could not read the face models: ${err instanceof Error ? err.message : String(err)}` };
      }
      queueMicrotask(markSent); // after this call's post below
    } else {
      await this.modelsSent;
    }
    const w = this.panel.webview;
    const ext = this.owner.ctx.context.extensionUri;
    const mp = vscode.Uri.joinPath(ext, 'node_modules', '@mediapipe', 'tasks-vision');
    return new Promise((resolve) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pendingFaces.delete(id);
        resolve({ error: 'the face model did not answer within 60 s' });
      }, 60000);
      this.pendingFaces.set(id, (f) => {
        clearTimeout(timer);
        resolve(f);
      });
      void post(w, {
        type: 'faces',
        id,
        data: pixels.data,
        width: pixels.width,
        height: pixels.height,
        runtime: {
          bundle: w.asWebviewUri(vscode.Uri.joinPath(mp, 'vision_bundle.js')).toString(),
          wasm: w.asWebviewUri(vscode.Uri.joinPath(mp, 'wasm')).toString(),
        },
        models: modelBytes,
      });
    });
  }

  dispose(): void {
    for (const r of this.pendingFaces.values()) {
      r({ error: 'the grid tab was closed' });
    }
    this.pendingFaces.clear();
    this.job.dispose();
    for (const resolve of this.pending.values()) {
      resolve(undefined);
    }
    this.pending.clear();
  }

  private get webview() {
    return this.panel.webview;
  }

  async reload(): Promise<void> {
    const { store } = this.owner.ctx;
    try {
      this.photos = await this.source.photos(this.sort);
    } catch (err) {
      void post(this.webview, { type: 'error', message: `Can't read ${this.source.title}: ${String(err)}` });
      return;
    }
    this.byKey = new Map(this.photos.map((p) => [p.key, p]));
    this.selected = this.selected.filter((k) => this.byKey.has(k));
    const tileSize = this.owner.ctx.context.globalState.get<number>('polaroica.tileSize', 160);
    // Ratings and shapes come from each photo's own folder, which in a tag album is not just one.
    const folders = [...new Set(this.photos.map((p) => path.dirname(p.photo.uri.fsPath)))];
    const culls = new Map(
      await Promise.all(
        folders.map(async (f) => [f, (await this.owner.ctx.edits?.cullingIn(f)) ?? new Map()] as const),
      ),
    );
    const caches = new Map(await Promise.all(folders.map(async (f) => [f, await store.cache.folder(f)] as const)));
    this.cull = new Map();
    const view = this.photos.map((p) => {
      const dir = path.dirname(p.photo.uri.fsPath);
      const cull = culls.get(dir)?.get(p.photo.name) ?? null;
      this.cull.set(p.key, cull ?? undefined);
      // The photo's shape, so the justified grid is laid out right before thumbnails arrive.
      const r = caches.get(dir)?.aspect(p.photo.name, p.photo.size, p.photo.mtime);
      return {
        ...toView(this.webview, p.photo),
        src: undefined,
        name: p.key,
        label: p.label,
        sub: p.sub,
        cull,
        ratio: r ? Math.round(r * 1000) / 1000 : undefined,
      };
    });
    void post(this.webview, {
      type: 'init',
      crumbs: this.source.crumbs(),
      album: this.source.kind,
      sort: this.sort,
      tileSize,
      detailsWidth: this.owner.ctx.context.globalState.get<number>(DETAILS_WIDTH, 0),
      selected: this.selected,
      photos: view,
    });
    this.owner.updateStatus();
    this.job.setPhotos(this.photos.map((p): JobPhoto => ({ key: p.key, photo: p.photo })));
    // Shown from the local index: check the share for edited files in the background.
    if (this.source.folder) {
      void store.revalidate(this.source.folder, true);
    }
    await this.sendDetails();
  }

  private async sendDetails(): Promise<void> {
    const key = this.focus && this.selected.includes(this.focus) ? this.focus : this.selected[this.selected.length - 1];
    const item = key ? this.byKey.get(key) : undefined;
    if (!item) {
      void post(this.webview, { type: 'details', details: undefined });
      return;
    }
    const photo = item.photo;
    const [rows, thumbs] = await Promise.all([
      detailRows(this.owner.ctx.store, photo),
      this.owner.ctx.thumbs.cached(vscode.Uri.file(path.dirname(photo.uri.fsPath)), [photo]),
    ]);
    // never load the original here
    const view = { ...toView(this.webview, photo), src: undefined, name: item.key, label: item.label, sub: item.sub };
    void post(this.webview, {
      type: 'details',
      details: { photo: view, rows, more: this.selected.length - 1, thumb: thumbs.get(photo.name)?.data },
    });
  }

  private async onMessage(m: FromGrid): Promise<void> {
    const { mover, host, context } = this.owner.ctx;
    const uriOf = (k: string) => this.byKey.get(k)?.photo.uri;
    const uris = (keys: string[]) => keys.map(uriOf).filter((u): u is vscode.Uri => !!u);
    /** The folder this grid *is*; album-wide actions are only offered for one. */
    const own = this.source.folder;
    switch (m.type) {
      case 'ready':
        this.markReady();
        await this.reload();
        break;
      case 'refresh':
        if (own) {
          await this.owner.ctx.store.recheck(own);
        } else {
          await this.reload();
        }
        break;
      case 'onscreen':
        this.job.setVisible(m.names);
        break;
      case 'decoded': {
        const resolve = this.pending.get(m.id);
        this.pending.delete(m.id);
        const data = fromWire(m.data);
        // Only keep real WebP output ("RIFF....WEBP"); never cache garbage.
        const ok = !!data && data.length > 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP';
        resolve?.(ok && m.w && m.h ? { data: data!, w: m.w, h: m.h } : undefined);
        break;
      }
      case 'open': {
        const uri = uriOf(m.name);
        if (uri) {
          host?.openPhoto(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath), this.sort);
        }
        break;
      }
      case 'select':
        this.selected = m.names;
        this.focus = m.focus;
        this.owner.updateStatus();
        await this.sendDetails();
        break;
      case 'move':
        await mover.moveWithPicker(uris(m.names));
        break;
      case 'reveal': {
        const uri = uriOf(m.name);
        if (uri) {
          await vscode.commands.executeCommand('revealFileInOS', uri);
        }
        break;
      }
      case 'sort':
        this.sort = m.key;
        await this.reload();
        break;
      case 'rate': {
        const { edits } = this.owner.ctx;
        if (edits && m.names.length) {
          const change: { rating?: number; flag?: 'pick' | 'reject' | null } = {};
          if (m.rating !== undefined) change.rating = m.rating;
          if (m.flag !== undefined) change.flag = m.flag;
          await edits.rate(uris(m.names), change).catch((err) => {
            void vscode.window.showErrorMessage(`Could not save the rating: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        break;
      }
      // Album-wide actions need a real folder; the webview hides them in a tag album.
      case 'autoRank':
        host?.autoRank?.(this.rankTarget());
        break;
      case 'undoAutoRank':
        host?.undoAutoRank?.(this.source.id);
        break;
      case 'deleteRejected':
        this.deleteRejected();
        break;
      case 'export':
        if (own) host?.exportPhotos?.(own, this.selected);
        break;
      case 'facesResult': {
        const r = this.pendingFaces.get(m.id);
        this.pendingFaces.delete(m.id);
        r?.(m.error ? { error: m.error } : { faces: m.faces ?? [] });
        break;
      }
      case 'makeBest': {
        const photo = uriOf(m.name);
        if (photo) host?.makeBest?.(photo, this.photos.map((p) => p.photo.uri));
        break;
      }
      case 'tileSize':
        await context.globalState.update('polaroica.tileSize', m.size);
        break;
      case 'detailsWidth':
        await context.globalState.update(DETAILS_WIDTH, Math.max(0, Math.round(m.width)) || undefined);
        break;
    }
  }
}
