import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore, sortSetting } from './photoStore';
import { Thumb } from './core/cache';
import { ThumbJob, ThumbService } from './thumbs';
import { fromWire, localRoots, post, webviewHtml } from './webview';

type FromGrid =
  | { type: 'ready' }
  | { type: 'open'; name: string }
  | { type: 'select'; names: string[]; focus?: string }
  | { type: 'move'; names: string[] }
  | { type: 'reveal'; name: string }
  | { type: 'sort'; key: SortKey }
  | { type: 'tileSize'; size: number }
  | { type: 'onscreen'; names: string[] }
  | { type: 'decoded'; id: number; data?: unknown; w?: number; h?: number }
  | { type: 'refresh' };

export interface GridHost {
  openPhoto(folder: vscode.Uri, name: string, sort: SortKey): void;
}

/** One editor tab per folder showing its photos as a grid (the library view). */
export class GridPanels implements vscode.Disposable {
  private readonly panels = new Map<string, GridPanel>();
  private readonly status: vscode.StatusBarItem;
  private host?: GridHost;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly mover: Mover,
    private readonly thumbs: ThumbService,
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
      'vsphoto.grid',
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
    this.status.text = `$(${lib && this.libraries.kind(lib) === 'smb' ? 'server' : 'device-desktop'}) ${n.toLocaleString()} photo${n === 1 ? '' : 's'}${sel ? ` · ${sel} selected` : ''}`;
    this.status.tooltip = active.folder.fsPath;
    this.status.show();
  }

  // shared by panels
  get ctx() {
    return { context: this.context, libraries: this.libraries, store: this.store, mover: this.mover, host: this.host, thumbs: this.thumbs };
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
  private sort: SortKey = sortSetting();
  private focus?: string;
  readonly job: ThumbJob;
  private nextId = 1;
  private readonly pending = new Map<number, (t: Thumb | undefined) => void>();

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly folder: vscode.Uri,
    private readonly owner: GridPanels,
  ) {
    const { context } = owner.ctx;
    panel.webview.html = webviewHtml(panel.webview, context.extensionUri, {
      title: path.basename(folder.fsPath),
      script: 'grid.js',
      style: 'grid.css',
      body: '<div id="app"></div>',
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

  dispose(): void {
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
    const tileSize = this.owner.ctx.context.globalState.get<number>('vsphoto.tileSize', 160);
    void post(this.webview, {
      type: 'init',
      crumbs: libraries.crumbs(this.folder),
      sort: this.sort,
      tileSize,
      selected: this.selected,
      photos: this.photos.map((p) => ({ ...toView(this.webview, p), src: undefined })),
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
      case 'tileSize':
        await context.globalState.update('vsphoto.tileSize', m.size);
        break;
    }
  }
}
