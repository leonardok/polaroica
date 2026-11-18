import * as path from 'path';
import * as vscode from 'vscode';
import { GridPanels } from './grid';
import { Libraries } from './libraries';
import { Mover } from './move';
import { Deleter } from './delete';
import { PhotoExporter } from './export';
import { CacheManager } from './core/cache';
import { disposeCodecs } from './core/codec';
import { formatBytes } from './core/images';
import { PhotoStore } from './photoStore';
import { ThumbService } from './thumbs';
import { EditStore } from './edits';
import { BackgroundThumbnails } from './background';
import { AutoRanker } from './autorank';
import { FolderNode, LibraryNode, LibraryTree, TreeNode } from './tree';
import { PhotoViewers } from './viewer';

export function activate(context: vscode.ExtensionContext): void {
  const libraries = new Libraries(context);
  const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'cache-v1').fsPath;
  const capMb = () => vscode.workspace.getConfiguration('vsphoto').get<number>('cacheSizeMB', 1024);
  const cache = new CacheManager(cacheDir, capMb() * 1024 * 1024);
  const store = new PhotoStore(cache);
  const thumbs = new ThumbService(store);
  const output = vscode.window.createOutputChannel('Photo Library');
  context.subscriptions.push(output);
  thumbs.log = (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  const edits = new EditStore(cache);
  const mover = new Mover(context, libraries, store, edits);
  const deleter = new Deleter(libraries, store, edits);
  const grids = new GridPanels(context, libraries, store, mover, thumbs, edits);
  const viewers = new PhotoViewers(context, libraries, store, mover, thumbs, edits);
  const exporter = new PhotoExporter(context, libraries, store, edits, (line) =>
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`),
  );
  exporter.openFolder = (folder) => grids.open(folder);
  grids.exporter = exporter;
  viewers.exporter = exporter;
  const ranker = new AutoRanker(
    context,
    store,
    edits,
    (folder, pixels, model) => grids.detectFaces(folder, pixels, model),
    (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`),
  );
  grids.setHost({
    openPhoto: (folder, name, sort) => viewers.open(folder, name, sort),
    autoRank: (folder) => void ranker.run(folder),
    undoAutoRank: (folder) => void ranker.undoRun(folder),
    makeBest: (folder, name) => void ranker.makeBest(folder, name),
    deleteRejected: (folder) => void deleter.deleteRejected(folder),
    exportPhotos: (folder, selected) => void exporter.exportFrom(folder, selected),
  });
  const background = new BackgroundThumbnails(libraries, store, thumbs, () => capMb() * 1024 * 1024, (photo, t) =>
    grids.offer(photo, t),
  );
  background.schedule();

  const tree = new LibraryTree(libraries, store, async (files, target) => {
    await mover.move(files, target);
  });
  tree.picksIn = async (folder) => {
    let n = 0;
    for (const c of (await edits.cullingIn(folder)).values()) {
      if (c.flag === 'pick') n++;
    }
    return n;
  };
  context.subscriptions.push(edits.onDidChange((photo) => void tree.picksChanged(path.dirname(photo.fsPath))));
  const view = vscode.window.createTreeView('vsphoto.libraries', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
    canSelectMany: true,
  });

  // A moved folder: close grids that showed it (their path no longer exists).
  mover.onDidMove((r) => {
    for (const m of r.moved) {
      grids.closeFor(m.from);
    }
  });

  const uriOf = (arg: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    if (arg instanceof LibraryNode || arg instanceof FolderNode) {
      return arg.uri;
    }
    return view.selection[0]?.uri;
  };

  // Watch libraries for changes made outside the extension (may not fire on every SMB server).
  const watchers: vscode.Disposable[] = [];
  const rewatch = () => {
    watchers.splice(0).forEach((w) => w.dispose());
    for (const f of libraries.all) {
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(f, '**/*'));
      const touch = (u: vscode.Uri) => store.invalidate(vscode.Uri.file(path.dirname(u.fsPath)));
      w.onDidCreate(touch);
      w.onDidDelete(touch);
      watchers.push(w);
    }
  };
  rewatch();

  context.subscriptions.push(
    store,
    edits,
    grids,
    viewers,
    view,
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    background,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rewatch();
      tree.refresh();
      background.schedule(3000);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsphoto.cacheSizeMB')) {
        cache.setCap(capMb() * 1024 * 1024);
      }
      if (e.affectsConfiguration('vsphoto.backgroundThumbnails')) {
        if (background.enabled) {
          background.schedule(1000);
        } else {
          background.stop();
        }
      }
      if (e.affectsConfiguration('vsphoto.thumbnailSize')) {
        background.schedule(3000);
      }
      if (e.affectsConfiguration('vsphoto.showPhotoCounts') || e.affectsConfiguration('vsphoto.sortBy')) {
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand('vsphoto.addLibrary', () => libraries.add()),
    vscode.commands.registerCommand('vsphoto.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('vsphoto.cacheInfo', async () => {
      const s = await cache.stats();
      const clear = 'Clear Cache';
      const pick = await vscode.window.showInformationMessage(
        `Photo Library cache: ${formatBytes(s.bytes)} of ${capMb()} MB, ${s.folders.toLocaleString()} folders` +
          (s.avgThumbBytes ? `, about ${formatBytes(s.avgThumbBytes)} per thumbnail` : ''),
        { detail: cacheDir },
        clear,
      );
      if (pick === clear) {
        background.stop();
        await cache.clear();
        store.invalidate();
        background.schedule(3000);
      }
    }),
    vscode.commands.registerCommand('vsphoto.autoRank', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        grids.open(uri);
        await ranker.run(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in Photo Libraries, or use the Auto-Rank button in a grid.');
      }
    }),
    vscode.commands.registerCommand('vsphoto.deleteRejected', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await deleter.deleteRejected(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in Photo Libraries, or use the Delete Rejects button in a grid.');
      }
    }),
    vscode.commands.registerCommand('vsphoto.exportPhotos', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await exporter.exportFrom(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in Photo Libraries, or use the Export button in a grid.');
      }
    }),
    vscode.commands.registerCommand('vsphoto.showLog', () => output.show()),
    vscode.commands.registerCommand('vsphoto.undoAutoRank', async (arg?: unknown) => {
      let uri = uriOf(arg);
      if (!uri) {
        const albums = ranker.undoable();
        if (!albums.length) {
          void vscode.window.showInformationMessage('Nothing to undo: no album was auto-ranked in this window.');
          return;
        }
        if (albums.length === 1) {
          uri = albums[0];
        } else {
          const pick = await vscode.window.showQuickPick(
            albums.map((a) => ({ label: path.basename(a.fsPath), description: path.dirname(a.fsPath), uri: a })),
            { title: 'Undo Auto-Rank', placeHolder: 'Which album? (most recent first)' },
          );
          uri = pick?.uri;
        }
      }
      if (uri) await ranker.undoRun(uri);
    }),
    vscode.commands.registerCommand('vsphoto.buildThumbnails', () => background.start()),
    vscode.commands.registerCommand('vsphoto.thumbnailProgress', async () => {
      const running = background.status === 'running';
      const paused = background.status === 'paused';
      const actions = running ? ['Pause', 'Stop'] : paused ? ['Resume', 'Stop'] : ['Start'];
      const pick = await vscode.window.showInformationMessage(background.summary(), ...actions, 'Show Log');
      if (pick === 'Show Log') {
        output.show();
        return;
      }
      if (pick === 'Pause') {
        background.pause();
      } else if (pick === 'Resume' || pick === 'Start') {
        background.resume();
      } else if (pick === 'Stop') {
        background.stop();
      }
    }),
    vscode.commands.registerCommand('vsphoto.removeLibrary', async (node?: TreeNode) => {
      const target = node instanceof LibraryNode ? node : view.selection.find((n) => n instanceof LibraryNode);
      if (target instanceof LibraryNode) {
        await libraries.remove(target.folder);
      }
    }),
    vscode.commands.registerCommand('vsphoto.openFolder', (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        grids.open(uri);
      }
    }),
    vscode.commands.registerCommand('vsphoto.moveTo', async (node?: TreeNode, nodes?: TreeNode[]) => {
      const picked = (nodes?.length ? nodes : node ? [node] : [...view.selection]).filter(
        (n): n is FolderNode => n instanceof FolderNode,
      );
      await mover.moveWithPicker(picked.map((n) => n.uri));
    }),
    vscode.commands.registerCommand('vsphoto.newFolder', async (arg?: unknown) => {
      const parent = uriOf(arg);
      if (!parent) {
        return;
      }
      const name = await vscode.window.showInputBox({
        title: `New folder in ${libraries.crumbs(parent).join(' / ')}`,
        validateInput: (v) => (/[\\/:*?"<>|]/.test(v) ? 'Name contains characters not allowed in file names' : undefined),
      });
      if (name) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(parent, name));
        store.invalidate(parent);
      }
    }),
    // Right-click menu inside the grid and photo tabs (webview/context). VS Code passes the
    // data-vscode-context of the clicked element: { webview, webviewSection, photo }.
    ...(['move', 'reveal', 'export'] as const).map((action) =>
      vscode.commands.registerCommand(
        action === 'move' ? 'vsphoto.photoMoveTo' : action === 'reveal' ? 'vsphoto.photoReveal' : 'vsphoto.photoExport',
        async (ctx?: { webview?: string; photo?: string }) => {
          if (ctx?.webview === 'vsphoto.grid') {
            await grids.contextAction(action, ctx.photo);
          } else if (ctx?.webview === 'vsphoto.photo') {
            await viewers.contextAction(action);
          }
        },
      ),
    ),
    vscode.commands.registerCommand('vsphoto.revealInOS', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }),
  );
}

export function deactivate(): void {
  disposeCodecs();
}
