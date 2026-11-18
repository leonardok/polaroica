import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore, sortSetting } from './photoStore';
import { Thumb } from './core/cache';
import { ThumbJob, ThumbService } from './thumbs';
import { EditStore } from './edits';
import { PhotoExporter } from './export';
import { DETAILS_WIDTH, fromWire, localRoots, post, webviewHtml } from './webview';
import * as fs from 'fs';
import { FaceModels } from './faceModel';
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
  autoRank?(folder: vscode.Uri): void;
  undoAutoRank?(folder: vscode.Uri): void;
  makeBest?(folder: vscode.Uri, name: string): void;
  deleteRejected?(folder: vscode.Uri): void;
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
          if (!folder || folder.fsPath === p.folder.fsPath) {
            void p.reload();
          }
        }
      }),
      ...(edits
        ? [
            edits.onDidChange((photo) => {
              const grid = this.panels.get(path.dirname(photo.fsPath));
              if (grid) {
                const name = path.basename(photo.fsPath);
                void edits.cullingIn(grid.folder.fsPath).then((map) => {
                  post(grid.panel.webview, { type: 'cull', name, cull: map.get(name) ?? null });
                  grid.cull.set(name, map.get(name));
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

  setHost(host: GridHost): void {
    this.host = host;
  }

  open(folder: vscode.Uri): void {
    const existing = this.panels.get(folder.fsPath);
    if (existing) {
      existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'polaroica.grid',
      path.basename(folder.fsPath) || folder.fsPath,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: localRoots(this.context.extensionUri) },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'grid-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'grid-dark.svg'),
    };
    const grid = new GridPanel(panel, folder, this);
    this.panels.set(folder.fsPath, grid);
    panel.onDidDispose(() => {
      grid.dispose();
      this.panels.delete(folder.fsPath);
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
  async contextAction(action: 'move' | 'reveal' | 'export', name: string | undefined): Promise<void> {
    const grid = [...this.panels.values()].find((p) => p.panel.active);
    if (!grid || !name) {
      return;
    }
    const uriOf = (n: string) => vscode.Uri.file(path.join(grid.folder.fsPath, n));
    if (action === 'reveal') {
      await vscode.commands.executeCommand('revealFileInOS', uriOf(name));
    } else if (action === 'export') {
      const names = grid.selected.includes(name) ? grid.selected : [name];
      await this.exporter?.exportPhotos(names.map(uriOf), grid.folder);
    } else {
      const names = grid.selected.includes(name) ? grid.selected : [name];
      await this.mover.moveWithPicker(names.map(uriOf));
    }
  }

  /** Face metrics for a photo, via the grid tab of its folder (opened if needed). */
  async detectFaces(folder: vscode.Uri, pixels: Rgba, models: FaceModels): Promise<{ faces?: FaceMetric[]; error?: string }> {
    if (!this.panels.get(folder.fsPath)) {
      this.open(folder);
    }
    const grid = this.panels.get(folder.fsPath);
    return grid ? grid.detectFaces(pixels, models) : { error: 'the grid tab could not be opened' };
  }

  /** A thumbnail made by the background builder: show it in an open grid of its folder. */
  offer(photo: Photo, t: Thumb): void {
    const grid = this.panels.get(path.dirname(photo.uri.fsPath));
    grid?.job.offer(photo, t);
  }

  /** Forget panels for a folder that was moved away. */
  closeFor(folder: vscode.Uri): void {
    for (const [k, p] of this.panels) {
      if (k === folder.fsPath || k.startsWith(folder.fsPath + path.sep)) {
        p.panel.dispose();
      }
    }
  }

  updateStatus(): void {
    const active = [...this.panels.values()].find((p) => p.panel.active);
    if (!active) {
      this.status.hide();
      return;
    }
    const lib = this.libraries.libraryOf(active.folder);
    const n = active.photos.length;
    const sel = active.selected.length;
    let picks = 0;
    let rejects = 0;
    for (const p of active.photos) {
      const c = active.cull.get(p.name);
      if (c?.flag === 'pick') picks++;
      else if (c?.flag === 'reject') rejects++;
    }
    this.status.text =
      `$(${lib && this.libraries.kind(lib) === 'smb' ? 'server' : 'device-desktop'}) ${n.toLocaleString()} photo${n === 1 ? '' : 's'}` +
      (picks ? ` · ${picks} picks` : '') +
      (rejects ? ` · ${rejects} rejects` : '') +
      (sel ? ` · ${sel} selected` : '');
    this.status.tooltip = active.folder.fsPath;
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
  photos: Photo[] = [];
  selected: string[] = [];
  /** Ratings and flags of this folder's photos (for the status bar). */
  cull = new Map<string, import('./edits').CullInfo | undefined>();
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
    readonly folder: vscode.Uri,
    private readonly owner: GridPanels,
  ) {
    const { context } = owner.ctx;
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: path.basename(folder.fsPath),
      script: ['faces.js', 'grid.js'],
      style: 'grid.css',
      body: '<div id="app"></div>',
      faces: true,
    });
    panel.webview.onDidReceiveMessage((m: FromGrid) => this.onMessage(m));
    this.job = owner.ctx.thumbs.job(folder, {
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
    const { store, libraries } = this.owner.ctx;
    try {
      this.photos = await store.photos(this.folder, this.sort);
    } catch (err) {
      void post(this.webview, { type: 'error', message: `Can't read ${this.folder.fsPath}: ${String(err)}` });
      return;
    }
    const names = new Set(this.photos.map((p) => p.name));
    this.selected = this.selected.filter((n) => names.has(n));
    const tileSize = this.owner.ctx.context.globalState.get<number>('polaroica.tileSize', 160);
    const cull = (await this.owner.ctx.edits?.cullingIn(this.folder.fsPath)) ?? new Map();
    this.cull = new Map(cull);
    // Each photo's shape, so the justified grid is laid out right before thumbnails arrive.
    const fc = await store.cache.folder(this.folder.fsPath);
    const ratio = (p: Photo) => {
      const r = fc.aspect(p.name, p.size, p.mtime);
      return r ? Math.round(r * 1000) / 1000 : undefined;
    };
    void post(this.webview, {
      type: 'init',
      crumbs: libraries.crumbs(this.folder),
      sort: this.sort,
      tileSize,
      detailsWidth: this.owner.ctx.context.globalState.get<number>(DETAILS_WIDTH, 0),
      selected: this.selected,
      photos: this.photos.map((p) => ({ ...toView(this.webview, p), src: undefined, cull: cull.get(p.name) ?? null, ratio: ratio(p) })),
    });
    this.owner.updateStatus();
    this.job.setPhotos(this.photos);
    // Shown from the local index: check the share for edited files in the background.
    void store.revalidate(this.folder, true);
    await this.sendDetails();
  }

  private async sendDetails(): Promise<void> {
    const name = this.focus && this.selected.includes(this.focus) ? this.focus : this.selected[this.selected.length - 1];
    const photo = this.photos.find((p) => p.name === name);
    if (!photo) {
      void post(this.webview, { type: 'details', details: undefined });
      return;
    }
    const [rows, thumbs] = await Promise.all([
      detailRows(this.owner.ctx.store, photo),
      this.owner.ctx.thumbs.cached(this.folder, [photo]),
    ]);
    const view = { ...toView(this.webview, photo), src: undefined }; // never load the original here
    void post(this.webview, {
      type: 'details',
      details: { photo: view, rows, more: this.selected.length - 1, thumb: thumbs.get(photo.name)?.data },
    });
  }

  private async onMessage(m: FromGrid): Promise<void> {
    const { mover, host, context } = this.owner.ctx;
    const uriOf = (n: string) => vscode.Uri.file(path.join(this.folder.fsPath, n));
    switch (m.type) {
      case 'ready':
        this.markReady();
        await this.reload();
        break;
      case 'refresh':
        await this.owner.ctx.store.recheck(this.folder);
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
      case 'open':
        host?.openPhoto(this.folder, m.name, this.sort);
        break;
      case 'select':
        this.selected = m.names;
        this.focus = m.focus;
        this.owner.updateStatus();
        await this.sendDetails();
        break;
      case 'move':
        await mover.moveWithPicker(m.names.map(uriOf));
        break;
      case 'reveal':
        await vscode.commands.executeCommand('revealFileInOS', uriOf(m.name));
        break;
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
          await edits.rate(m.names.map(uriOf), change).catch((err) => {
            void vscode.window.showErrorMessage(`Could not save the rating: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        break;
      }
      case 'autoRank':
        host?.autoRank?.(this.folder);
        break;
      case 'undoAutoRank':
        host?.undoAutoRank?.(this.folder);
        break;
      case 'deleteRejected':
        host?.deleteRejected?.(this.folder);
        break;
      case 'export':
        host?.exportPhotos?.(this.folder, this.selected);
        break;
      case 'facesResult': {
        const r = this.pendingFaces.get(m.id);
        this.pendingFaces.delete(m.id);
        r?.(m.error ? { error: m.error } : { faces: m.faces ?? [] });
        break;
      }
      case 'makeBest':
        host?.makeBest?.(this.folder, m.name);
        break;
      case 'tileSize':
        await context.globalState.update('polaroica.tileSize', m.size);
        break;
      case 'detailsWidth':
        await context.globalState.update(DETAILS_WIDTH, Math.max(0, Math.round(m.width)) || undefined);
        break;
    }
  }
}
