import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore } from './photoStore';
import { isDisplayable, isRaw } from './core/images';
import { rawPreview, ThumbService } from './thumbs';
import { localRoots, webviewHtml } from './webview';

type FromViewer =
  | { type: 'ready' }
  | { type: 'step'; delta: number }
  | { type: 'goto'; index: number }
  | { type: 'grid' }
  | { type: 'move' }
  | { type: 'reveal' };

const STRIP_RADIUS = 6;

/** Photo tabs: each opened photo gets its own tab; ← → browse the folder inside that tab. */
export class PhotoViewers implements vscode.Disposable {
  private readonly viewers = new Set<PhotoViewer>();

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly libraries: Libraries,
    readonly store: PhotoStore,
    readonly mover: Mover,
    readonly thumbs: ThumbService,
  ) {
    context.subscriptions.push(
      store.onDidChange((folder) => {
        for (const v of this.viewers) {
          if (!folder || folder.fsPath === v.folder.fsPath) {
            void v.reloadList();
          }
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        for (const v of this.viewers) {
          v.panel.webview.options = { ...v.panel.webview.options, localResourceRoots: localRoots(context.extensionUri) };
        }
      }),
    );
  }

  open(folder: vscode.Uri, name: string, sort: SortKey): void {
    const file = path.join(folder.fsPath, name);
    for (const v of this.viewers) {
      if (v.current?.uri.fsPath === file) {
        v.panel.reveal();
        return;
      }
    }
    const panel = vscode.window.createWebviewPanel(
      'vsphoto.photo',
      name,
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: localRoots(this.context.extensionUri) },
    );
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'photo-light.svg'),
      dark: vscode.Uri.joinPath(this.context.extensionUri, 'media', 'photo-dark.svg'),
    };
    const viewer = new PhotoViewer(panel, folder, name, sort, this);
    this.viewers.add(viewer);
    panel.onDidDispose(() => this.viewers.delete(viewer));
  }

  dispose(): void {
    for (const v of this.viewers) {
      v.panel.dispose();
    }
  }
}

class PhotoViewer {
  private photos: Photo[] = [];
  private index = 0;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly folder: vscode.Uri,
    private name: string,
    private readonly sort: SortKey,
    private readonly owner: PhotoViewers,
  ) {
    panel.webview.html = webviewHtml(panel.webview, owner.context.extensionUri, {
      title: name,
      script: 'viewer.js',
      style: 'viewer.css',
      body: '<div id="app"></div>',
    });
    panel.webview.onDidReceiveMessage((m: FromViewer) => this.onMessage(m));
  }

  get current(): Photo | undefined {
    return this.photos[this.index];
  }

  private generation = 0;

  /**
   * Re-read the folder. If the shown photo was moved away, the tab stays in this folder and
   * shows the photo that took its place (handy when sorting photos one by one).
   */
  async reloadList(): Promise<void> {
    const gen = ++this.generation;
    let photos: Photo[];
    try {
      photos = await this.owner.store.photos(this.folder, this.sort);
    } catch (err) {
      void this.panel.webview.postMessage({ type: 'error', message: `Can't read ${this.folder.fsPath}: ${String(err)}` });
      return;
    }
    if (gen !== this.generation) {
      return; // a newer reload is on its way
    }
    this.photos = photos;
    const i = this.photos.findIndex((p) => p.name === this.name);
    if (i >= 0) {
      this.index = i;
    } else {
      // The photo is gone (moved or deleted elsewhere): stay at the same position.
      this.index = Math.min(this.index, this.photos.length - 1);
    }
    await this.show();
  }

  private async show(): Promise<void> {
    const photo = this.current;
    const webview = this.panel.webview;
    if (!photo) {
      this.panel.title = 'No photos';
      void webview.postMessage({ type: 'empty', crumbs: this.owner.libraries.crumbs(this.folder) });
      return;
    }
    this.name = photo.name;
    this.panel.title = photo.name;
    const from = Math.max(0, this.index - STRIP_RADIUS);
    const to = Math.min(this.photos.length, this.index + STRIP_RADIUS + 1);
    const near = this.photos.slice(from, to);
    // Thumbnails come from the local cache: the filmstrip and a stand-in for the main photo
    // show at once, while the original streams in from the share.
    const cached = await this.owner.thumbs.cached(this.folder, near);
    if (this.current !== photo) {
      return; // moved on while reading
    }
    const view = toView(webview, photo);
    const raw = isRaw(photo.name);
    const neighbours = [this.photos[this.index + 1], this.photos[this.index - 1]]
      .filter((p): p is Photo => !!p && isDisplayable(p.name))
      .map((p) => webview.asWebviewUri(p.uri).toString());
    void webview.postMessage({
      type: 'show',
      crumbs: this.owner.libraries.crumbs(this.folder),
      index: this.index,
      total: this.photos.length,
      photo: view,
      thumb: cached.get(photo.name)?.data,
      // RAW: the preview JPEG embedded in the file is sent separately once read.
      waitForPreview: raw,
      strip: near.map((p, k) => ({
        index: from + k,
        name: p.name,
        ext: toView(webview, p).ext,
        thumb: cached.get(p.name)?.data,
      })),
      preload: neighbours,
    });

    const work: Promise<unknown>[] = [
      detailRows(this.owner.store, photo).then((rows) => {
        if (this.current === photo) {
          void webview.postMessage({ type: 'details', rows });
        }
      }),
    ];
    if (raw) {
      work.push(
        rawPreview(photo.uri.fsPath).then((data) => {
          if (this.current === photo) {
            void webview.postMessage({ type: 'preview', name: photo.name, data });
          }
        }),
      );
    } else if (!cached.has(photo.name)) {
      work.push(
        this.owner.thumbs.placeholder(photo).then((data) => {
          if (data && this.current === photo) {
            void webview.postMessage({ type: 'placeholder', name: photo.name, data });
          }
        }),
      );
    }
    await Promise.all(work);
  }

  private async onMessage(m: FromViewer): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.reloadList();
        break;
      case 'step':
        if (this.photos.length) {
          this.index = (this.index + m.delta + this.photos.length) % this.photos.length;
          await this.show();
        }
        break;
      case 'goto':
        if (m.index >= 0 && m.index < this.photos.length) {
          this.index = m.index;
          await this.show();
        }
        break;
      case 'grid':
        await vscode.commands.executeCommand('vsphoto.openFolder', this.folder);
        break;
      case 'move':
        if (this.current) {
          await this.owner.mover.moveWithPicker([this.current.uri]);
        }
        break;
      case 'reveal':
        if (this.current) {
          await vscode.commands.executeCommand('revealFileInOS', this.current.uri);
        }
        break;
    }
  }
}
