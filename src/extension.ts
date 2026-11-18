import * as path from 'path';
import * as vscode from 'vscode';
import { GridPanels } from './grid';
import { Libraries } from './libraries';
import { Mover } from './move';
import { CacheManager } from './core/cache';
import { formatBytes } from './core/images';
import { PhotoStore } from './photoStore';
import { ThumbService } from './thumbs';
import { FolderNode, LibraryNode, LibraryTree, TreeNode } from './tree';
import { PhotoViewers } from './viewer';

export function activate(context: vscode.ExtensionContext): void {
  const libraries = new Libraries(context);
  const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'cache-v1').fsPath;
  const capMb = () => vscode.workspace.getConfiguration('vsphoto').get<number>('cacheSizeMB', 512);
  const cache = new CacheManager(cacheDir, capMb() * 1024 * 1024);
  const store = new PhotoStore(cache);
  const thumbs = new ThumbService(store);
  const mover = new Mover(context, libraries, store);
  const grids = new GridPanels(context, libraries, store, mover, thumbs);
  const viewers = new PhotoViewers(context, libraries, store, mover, thumbs);
  grids.setHost({ openPhoto: (folder, name, sort) => viewers.open(folder, name, sort) });

  const tree = new LibraryTree(libraries, store, async (files, target) => {
    await mover.move(files, target);
  });
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
    grids,
    viewers,
    view,
    { dispose: () => watchers.forEach((w) => w.dispose()) },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rewatch();
      tree.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vsphoto.cacheSizeMB')) {
        cache.setCap(capMb() * 1024 * 1024);
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
        await cache.clear();
        store.invalidate();
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
    vscode.commands.registerCommand('vsphoto.revealInOS', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }),
  );
}

export function deactivate(): void {
  /* nothing: disposables are on the context */
}
