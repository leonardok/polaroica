import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey } from './core/images';
import { detailRows, toView } from './details';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Photo, PhotoStore } from './photoStore';
import { isDisplayable, isRaw } from './core/images';
import { rawPreview, ThumbService } from './thumbs';
import { DETAILS_WIDTH, localRoots, post, webviewHtml } from './webview';
import * as fs from 'fs';
import { EditStore } from './edits';
import { PhotoExporter } from './export';
import { normalizeEdits } from './core/xmp';
import { rawAsShotKelvin } from './core/exporter';
import { mimeOf } from './thumbs';
import { storedFaceBoxes } from './autorank';

type FromViewer =
  | { type: 'ready' }
  | { type: 'step'; delta: number }
  | { type: 'goto'; index: number }
  | { type: 'grid' }
  | { type: 'move' }
  | { type: 'reveal' }
  | { type: 'needBytes'; name: string }
  | { type: 'saveEdits'; name: string; edits: unknown }
  | { type: 'copyEdits'; edits: unknown }
  | { type: 'pasteEdits' }
  | { type: 'rate'; name: string; rating?: number; flag?: 'pick' | 'reject' | null }
  | { type: 'detailsWidth'; width: number };

const STRIP_RADIUS = 6;

/** Photo tabs: each opened photo gets its own tab; ← → browse the folder inside that tab. */
const TWEAK_KEYS = ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation'] as const;

/** The Auto Adjust settings: amounts added on top of what Auto sets (all 0 by default). */
function autoTweaks(): Record<string, number> {
  const cfg = vscode.workspace.getConfiguration('polaroica.autoAdjust');
  const out: Record<string, number> = {};
  for (const k of TWEAK_KEYS) {
    const v = Number(cfg.get<number>(k, 0));
    if (Number.isFinite(v) && v) out[k] = v;
  }
  return out;
}

export class PhotoViewers implements vscode.Disposable {
  private readonly viewers = new Set<PhotoViewer>();
  /** Export (right-click → Export…), set by the extension. */
  exporter?: PhotoExporter;
  /** As-shot white balance of RAW files (Kelvin), by path, size and date. */
  private readonly asShotCache = new Map<string, Promise<number | undefined>>();

  /** A RAW file's as-shot white balance in Kelvin (from its header); undefined for others. */
  asShot(photo: Photo): Promise<number | undefined> {
    if (!isRaw(photo.name)) {
      return Promise.resolve(undefined);
    }
    const key = `${photo.uri.fsPath}|${photo.size}|${photo.mtime}`;
    let p = this.asShotCache.get(key);
    if (!p) {
      p = rawAsShotKelvin(photo.uri.fsPath).catch(() => undefined);
      this.asShotCache.set(key, p);
    }
    return p;
  }

  constructor(
    readonly context: vscode.ExtensionContext,
    readonly libraries: Libraries,
    readonly store: PhotoStore,
    readonly mover: Mover,
    readonly thumbs: ThumbService,
    readonly edits: EditStore,
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
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('polaroica.autoAdjust')) {
          const tweaks = autoTweaks();
          for (const v of this.viewers) void post(v.panel.webview, { type: 'autoTweaks', tweaks });
        }
      }),
    );
  }

  /** Right-click menu on the photo in the active photo tab. */
  async contextAction(action: 'move' | 'reveal' | 'export' | 'copyPath'): Promise<void> {
    const v = [...this.viewers].find((x) => x.panel.active);
    const photo = v?.current;
    if (!photo) {
      return;
    }
    if (action === 'reveal') {
      await vscode.commands.executeCommand('revealFileInOS', photo.uri);
    } else if (action === 'copyPath') {
      await vscode.env.clipboard.writeText(photo.uri.fsPath);
    } else if (action === 'export') {
      await this.exporter?.exportPhotos([photo.uri]);
    } else {
      await this.mover.moveWithPicker([photo.uri]);
    }
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
      'polaroica.photo',
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
      script: ['adjust.js', 'viewer.js'],
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
      void post(this.panel.webview, { type: 'error', message: `Can't read ${this.folder.fsPath}: ${String(err)}` });
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
      void post(webview, { type: 'empty', crumbs: this.owner.libraries.crumbs(this.folder) });
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
    const [edits, cullMap, faces] = await Promise.all([
      this.owner.edits.load(photo.uri),
      this.owner.edits.cullingIn(this.folder.fsPath),
      storedFaceBoxes(this.owner.store, photo).catch(() => []),
    ]);
    if (this.current !== photo) {
      return;
    }
    const neighbours = [this.photos[this.index + 1], this.photos[this.index - 1]]
      .filter((p): p is Photo => !!p && isDisplayable(p.name))
      .map((p) => webview.asWebviewUri(p.uri).toString());
    void post(webview, {
      type: 'show',
      crumbs: this.owner.libraries.crumbs(this.folder),
      detailsWidth: this.owner.context.globalState.get<number>(DETAILS_WIDTH, 0),
      index: this.index,
      total: this.photos.length,
      photo: view,
      thumb: cached.get(photo.name)?.data,
      thumbQuick: cached.get(photo.name)?.quick,
      // RAW: the preview JPEG embedded in the file is sent separately once read.
      waitForPreview: raw,
      strip: near.map((p, k) => ({
        index: from + k,
        name: p.name,
        ext: toView(webview, p).ext,
        thumb: cached.get(p.name)?.data,
        edited: !!cullMap.get(p.name)?.edited,
        flag: cullMap.get(p.name)?.flag,
      })),
      preload: neighbours,
      edits,
      cull: cullMap.get(photo.name) ?? null,
      canPaste: !!this.owner.edits.clipboard,
      faces,
      autoTweaks: autoTweaks(),
    });

    const work: Promise<unknown>[] = [
      detailRows(this.owner.store, photo).then((rows) => {
        if (this.current === photo) {
          void post(webview, { type: 'details', rows });
        }
      }),
    ];
    if (raw) {
      work.push(
        rawPreview(photo.uri.fsPath).then((data) => {
          if (this.current === photo) {
            void post(webview, { type: 'preview', name: photo.name, data });
          }
        }),
        // The camera's as-shot white balance: where the Temperature slider starts.
        this.owner.asShot(photo).then((kelvin) => {
          if (kelvin && this.current === photo) {
            void post(webview, { type: 'whiteBalance', name: photo.name, kelvin, source: 'camera' });
          }
        }),
      );
    } else if (!cached.has(photo.name)) {
      work.push(
        this.owner.thumbs.quick(photo, this.owner.thumbs.fgHeads).then((t) => {
          if (t && this.current === photo) {
            void post(webview, { type: 'placeholder', name: photo.name, data: t.data });
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
        await vscode.commands.executeCommand('polaroica.openFolder', this.folder);
        break;
      case 'needBytes': {
        // The editor renders with WebGL from the photo's bytes (a blob, so the canvas is never
        // "tainted" by a cross-origin image).
        const photo = this.current;
        if (!photo || photo.name !== m.name) {
          break;
        }
        const data = isRaw(photo.name)
          ? await rawPreview(photo.uri.fsPath)
          : await fs.promises.readFile(photo.uri.fsPath).catch(() => undefined);
        if (this.current === photo) {
          void post(this.panel.webview, { type: 'bytes', name: photo.name, data, mime: isRaw(photo.name) ? 'image/jpeg' : mimeOf(photo.name) });
        }
        break;
      }
      case 'saveEdits': {
        const photo = this.photos.find((p) => p.name === m.name);
        if (photo) {
          try {
            await this.owner.edits.save(photo.uri, normalizeEdits(m.edits));
          } catch (err) {
            void vscode.window.showErrorMessage(`Could not save edits for ${photo.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        break;
      }
      case 'rate': {
        const photo = this.photos.find((p) => p.name === m.name);
        if (photo) {
          const change: { rating?: number; flag?: 'pick' | 'reject' | null } = {};
          if (m.rating !== undefined) change.rating = m.rating;
          if (m.flag !== undefined) change.flag = m.flag;
          await this.owner.edits.rate([photo.uri], change).catch((err) => {
            void vscode.window.showErrorMessage(`Could not save the rating: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        break;
      }
      case 'copyEdits':
        this.owner.edits.clipboard = normalizeEdits(m.edits);
        break;
      case 'pasteEdits':
        if (this.owner.edits.clipboard) {
          void post(this.panel.webview, { type: 'paste', edits: this.owner.edits.clipboard });
        }
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
      case 'detailsWidth':
        await this.owner.context.globalState.update(DETAILS_WIDTH, Math.max(0, Math.round(m.width)) || undefined);
        break;
    }
  }
}
