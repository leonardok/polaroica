import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore, sortSetting } from './photoStore';
import { localRoots, webviewHtml } from './webview';

type FromGrid =
  | { type: 'ready' }
  | { type: 'open'; name: string }
  | { type: 'select'; names: string[]; focus?: string }
  | { type: 'move'; names: string[] }
  | { type: 'reveal'; name: string }
  | { type: 'sort'; key: SortKey }
  | { type: 'tileSize'; size: number }
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
      this.panels.delete(folder.fsPath);
      this.updateStatus();
    });
    panel.onDidChangeViewState((e) => {
      this.updateStatus();
      // Stop pulling photos over the network while the grid is not on screen.
      void panel.webview.postMessage({ type: 'visible', visible: e.webviewPanel.visible });
    });
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
    return { context: this.context, libraries: this.libraries, store: this.store, mover: this.mover, host: this.host };
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
  }

  private get webview() {
    return this.panel.webview;
  }

  async reload(): Promise<void> {
    const { store, libraries } = this.owner.ctx;
    try {
      this.photos = await store.photos(this.folder, this.sort);
    } catch (err) {
      void this.webview.postMessage({ type: 'error', message: `Can't read ${this.folder.fsPath}: ${String(err)}` });
      return;
    }
    const names = new Set(this.photos.map((p) => p.name));
    this.selected = this.selected.filter((n) => names.has(n));
    const tileSize = this.owner.ctx.context.globalState.get<number>('vsphoto.tileSize', 160);
    void this.webview.postMessage({
      type: 'init',
      crumbs: libraries.crumbs(this.folder),
      sort: this.sort,
      tileSize,
      selected: this.selected,
      photos: this.photos.map((p) => toView(this.webview, p)),
    });
    this.owner.updateStatus();
    await this.sendDetails();
  }

  private async sendDetails(): Promise<void> {
    const name = this.focus && this.selected.includes(this.focus) ? this.focus : this.selected[this.selected.length - 1];
    const photo = this.photos.find((p) => p.name === name);
    if (!photo) {
      void this.webview.postMessage({ type: 'details', details: undefined });
      return;
    }
    const rows = await detailRows(this.owner.ctx.store, photo);
    void this.webview.postMessage({
      type: 'details',
      details: { photo: toView(this.webview, photo), rows, more: this.selected.length - 1 },
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
        this.owner.ctx.store.invalidate(this.folder);
        break;
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
