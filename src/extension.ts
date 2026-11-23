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
import { FolderNode, LibraryNode, LibraryTree, TagNode, TreeNode } from './tree';
import { TagIndex } from './tagIndex';
import { applyTags, describeResult, TagScanner } from './tags';
import { TagSource } from './photoSource';
import { PhotoViewers } from './viewer';

/** Settings keys that were called `vsphoto.*` before the project was renamed to Polaroica. */
const LEGACY_SETTINGS = [
  'sortBy',
  'showPhotoCounts',
  'thumbnailSize',
  'cacheSizeMB',
  'backgroundThumbnails',
  'autoRank.burstSeconds',
  'autoRank.sceneSeconds',
  'export.quality',
];

/** Copies `vsphoto.*` settings to `polaroica.*` where the new key isn't set yet. */
async function migrateLegacySettings(): Promise<void> {
  const oldCfg = vscode.workspace.getConfiguration('vsphoto');
  const newCfg = vscode.workspace.getConfiguration('polaroica');
  for (const key of LEGACY_SETTINGS) {
    const was = oldCfg.inspect(key);
    const now = newCfg.inspect(key);
    if (!was || !now) {
      continue;
    }
    try {
      if (was.globalValue !== undefined && now.globalValue === undefined) {
        await newCfg.update(key, was.globalValue, vscode.ConfigurationTarget.Global);
      }
      if (was.workspaceValue !== undefined && now.workspaceValue === undefined && vscode.workspace.workspaceFolders) {
        await newCfg.update(key, was.workspaceValue, vscode.ConfigurationTarget.Workspace);
      }
    } catch {
      /* a read-only settings file: keep the defaults */
    }
  }
}

export function activate(context: vscode.ExtensionContext): void {
  void migrateLegacySettings();
  const libraries = new Libraries(context);
  const cacheDir = vscode.Uri.joinPath(context.globalStorageUri, 'cache-v1').fsPath;
  const capMb = () => vscode.workspace.getConfiguration('polaroica').get<number>('cacheSizeMB', 1024);
  const cache = new CacheManager(cacheDir, capMb() * 1024 * 1024);
  const store = new PhotoStore(cache);
  const thumbs = new ThumbService(store);
  const output = vscode.window.createOutputChannel('Polaroica');
  context.subscriptions.push(output);
  thumbs.log = (line) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  const edits = new EditStore(cache);
  const mover = new Mover(context, libraries, store, edits);
  const deleter = new Deleter(libraries, store, edits);
  const tagIndex = new TagIndex(context.globalStorageUri.fsPath);
  const tagScanner = new TagScanner(store, edits, tagIndex);
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
  // Lazy thumbnails: opening an album fills in its own (not its sub-albums').
  grids.onOpen = (folder) => background.albumOpened(folder);

  const tree = new LibraryTree(libraries, store, async (files, target) => {
    await mover.move(files, target);
  });
  tree.media = vscode.Uri.joinPath(context.extensionUri, 'media');
  tree.cullingIn = (folder) => edits.cullingIn(folder);
  tree.tags = tagIndex;
  context.subscriptions.push(edits.onDidChange((photo) => tree.cullingChanged(path.dirname(photo.fsPath))));
  const view = vscode.window.createTreeView('polaroica.libraries', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    showCollapseAll: true,
    canSelectMany: true,
  });

  // A moved folder: close grids that showed it (their path no longer exists).
  // The index drops a record whose photo is gone or has changed, which happens while a tag grid is
  // being filled. Without this the Tags row keeps showing a count no photo backs any more.
  let tagsDirty: NodeJS.Timeout | undefined;
  tagIndex.onChanged = () => {
    clearTimeout(tagsDirty);
    tagsDirty = setTimeout(() => tree.tagsChanged(), 150);
  };
  context.subscriptions.push({ dispose: () => clearTimeout(tagsDirty) });

  // Photos renamed or deleted outside Polaroica leave records pointing at nothing. Clearing them
  // out once at startup keeps the Tags counts honest without waiting for a grid to be opened; a
  // folder that can't be reached is left alone (see TagIndex.prune).
  void tagIndex.prune().then(
    (n) => n && output.appendLine(`[tags] forgot ${n} photo${n === 1 ? '' : 's'} that are no longer there`),
    () => undefined,
  );

  mover.onDidMove((r) => {
    for (const m of r.moved) {
      grids.closeFor(m.from);
      // The sidecar went with the photo; the index has to follow or the tag points nowhere.
      void tagIndex.forgetUnder(m.from.fsPath);
    }
    tree.tagsChanged();
    grids.reloadTagGrids();
  });

  const uriOf = (arg: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    if (arg instanceof LibraryNode || arg instanceof FolderNode) {
      return arg.uri;
    }
    const sel = view.selection[0];
    return sel instanceof LibraryNode || sel instanceof FolderNode ? sel.uri : undefined;
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
    new vscode.Disposable(() => void tagIndex.flush()),
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
      if (e.affectsConfiguration('polaroica.cacheSizeMB')) {
        cache.setCap(capMb() * 1024 * 1024);
      }
      if (e.affectsConfiguration('polaroica.backgroundThumbnails')) {
        if (background.enabled) {
          background.schedule(1000);
        } else {
          background.stopBuildAll();
        }
      }
      if (e.affectsConfiguration('polaroica.thumbnailSize')) {
        background.schedule(3000);
      }
      if (e.affectsConfiguration('polaroica.showPhotoCounts') || e.affectsConfiguration('polaroica.sortBy')) {
        tree.refresh();
      }
    }),

    vscode.commands.registerCommand('polaroica.addLibrary', () => libraries.add()),
    vscode.commands.registerCommand('polaroica.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('polaroica.cacheInfo', async () => {
      const s = await cache.stats();
      const clear = 'Clear Cache';
      const pick = await vscode.window.showInformationMessage(
        `Polaroica cache: ${formatBytes(s.bytes)} of ${capMb()} MB, ${s.folders.toLocaleString()} folders` +
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
    vscode.commands.registerCommand('polaroica.autoRank', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        grids.open(uri);
        await ranker.run(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in the Polaroica sidebar, or use the Auto-Rank button in a grid.');
      }
    }),
    vscode.commands.registerCommand('polaroica.deleteRejected', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await deleter.deleteRejected(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in the Polaroica sidebar, or use the Delete Rejects button in a grid.');
      }
    }),
    vscode.commands.registerCommand('polaroica.exportPhotos', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await exporter.exportFrom(uri);
      } else {
        void vscode.window.showInformationMessage('Right-click an album in the Polaroica sidebar, or use the Export button in a grid.');
      }
    }),
    vscode.commands.registerCommand('polaroica.showLog', () => output.show()),
    vscode.commands.registerCommand('polaroica.undoAutoRank', async (arg?: unknown) => {
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
    vscode.commands.registerCommand('polaroica.buildThumbnails', () => background.buildAll()),
    vscode.commands.registerCommand('polaroica.buildThumbnailsHere', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (!uri) {
        void vscode.window.showInformationMessage('Right-click an album in the Polaroica sidebar to build its thumbnails.');
        return;
      }
      const name = path.basename(uri.fsPath) || uri.fsPath;
      const listing = await store.listing(uri).catch(() => undefined);
      let recursive = false;
      if (listing?.folders.length) {
        const only = { label: `$(file-media) ${name}`, detail: 'Just the photos in this album', recursive: false };
        const all = { label: `$(folder-library) ${name} and its sub-albums`, detail: 'Every album inside it too', recursive: true };
        const pick = await vscode.window.showQuickPick([only, all], { title: 'Build Thumbnails Here', placeHolder: 'Which photos?' });
        if (!pick) {
          return;
        }
        recursive = pick.recursive;
      } else if (listing && !listing.photos.length) {
        void vscode.window.showInformationMessage(`${name} has no photos.`);
        return;
      }
      background.buildHere(uri, recursive);
    }),
    vscode.commands.registerCommand('polaroica.thumbnailProgress', async () => {
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
    vscode.commands.registerCommand('polaroica.removeLibrary', async (node?: TreeNode) => {
      const target = node instanceof LibraryNode ? node : view.selection.find((n) => n instanceof LibraryNode);
      if (target instanceof LibraryNode) {
        await libraries.remove(target.folder);
      }
    }),
    vscode.commands.registerCommand('polaroica.scanTags', async (arg?: unknown) => {
      let uri = uriOf(arg);
      if (!uri) {
        // From the palette with nothing selected in the tree: ask which library to look through.
        const libs = libraries.all;
        if (!libs.length) {
          void vscode.window.showInformationMessage('Add a photo library first.');
          return;
        }
        if (libs.length === 1) {
          uri = libs[0].uri;
        } else {
          const pick = await vscode.window.showQuickPick(
            libs.map((l) => ({ label: l.name, description: l.uri.fsPath, uri: l.uri })),
            { title: 'Look for documents and screenshots in…' },
          );
          if (!pick) {
            return;
          }
          uri = pick.uri;
        }
      }
      const result = await tagScanner.scan(uri, true);
      tree.tagsChanged();
      grids.reloadTagGrids();
      const tags = [...result.byTag.keys()];
      const open = tags.length === 1 ? `Show ${tags[0]}` : undefined;
      const pick = await vscode.window.showInformationMessage(describeResult(result), ...(open ? [open] : []));
      if (open && pick === open) {
        grids.openSource(new TagSource(tags[0], tagIndex, libraries));
      }
    }),
    vscode.commands.registerCommand('polaroica.photoTag', async (ctx?: { webview?: string; photo?: string }) => {
      if (ctx?.webview !== 'polaroica.grid') {
        return;
      }
      const photos = grids.selectionFor(ctx.photo);
      if (!photos.length) {
        return;
      }
      // Offer the tags already in use, and let a new one be typed. A tag some of the selection
      // already has says so, so it's clear what adding it will change.
      const counts = await tagIndex.allTags();
      const mine = await tagsOfAll(edits, photos);
      const NEW = '$(add) New tag…';
      const pick = await vscode.window.showQuickPick(
        [
          ...counts.map((c) => ({
            label: c.tag,
            description: onHowMany(mine, c.tag, photos.length) ?? `${c.photos.toLocaleString()} photos`,
          })),
          { label: NEW, description: '' },
        ],
        { title: `Tag ${photos.length === 1 ? '1 photo' : `${photos.length} photos`}` },
      );
      if (!pick) {
        return;
      }
      let tag = pick.label;
      if (tag === NEW) {
        const typed = await vscode.window.showInputBox({
          title: 'New tag',
          prompt: 'A keyword to find these photos by later',
          validateInput: (v) => (v.trim() ? undefined : 'Type a tag'),
        });
        if (!typed?.trim()) {
          return;
        }
        tag = typed.trim();
      }
      // Already on every one of them: take the tag off instead, so the menu toggles.
      const have = tag === pick.label ? mine : await tagsOfAll(edits, photos);
      const all = have.every((ts) => ts.some((t) => t.toLowerCase() === tag.toLowerCase()));
      await applyTags(edits, tagIndex, photos, all ? { remove: [tag] } : { add: [tag] });
      tree.tagsChanged();
      grids.reloadTagGrids();
      void vscode.window.showInformationMessage(
        `${all ? 'Removed' : 'Added'} "${tag}" ${all ? 'from' : 'to'} ${photos.length === 1 ? '1 photo' : `${photos.length} photos`}.`,
      );
    }),
    vscode.commands.registerCommand('polaroica.photoUntag', async (ctx?: { webview?: string; photo?: string }) => {
      if (ctx?.webview !== 'polaroica.grid') {
        return;
      }
      const photos = grids.selectionFor(ctx.photo);
      if (!photos.length) {
        return;
      }
      // Only the tags the selection actually carries can be taken off it.
      const mine = await tagsOfAll(edits, photos);
      const here = new Map<string, string>();
      for (const ts of mine) {
        for (const t of ts) {
          if (!here.has(t.toLowerCase())) {
            here.set(t.toLowerCase(), t);
          }
        }
      }
      if (!here.size) {
        void vscode.window.showInformationMessage(
          photos.length === 1 ? 'That photo has no tags.' : 'None of those photos has a tag.',
        );
        return;
      }
      const picks = await vscode.window.showQuickPick(
        [...here.values()].sort((a, b) => a.localeCompare(b)).map((tag) => ({
          label: tag,
          description: onHowMany(mine, tag, photos.length),
        })),
        {
          title: `Remove tags from ${photos.length === 1 ? '1 photo' : `${photos.length} photos`}`,
          canPickMany: true,
          placeHolder: 'Pick the tags to take off',
        },
      );
      if (!picks?.length) {
        return;
      }
      const tags = picks.map((p) => p.label);
      await applyTags(edits, tagIndex, photos, { remove: tags });
      tree.tagsChanged();
      grids.reloadTagGrids();
      void vscode.window.showInformationMessage(
        `Removed ${tags.map((t) => `"${t}"`).join(', ')} from ${
          photos.length === 1 ? '1 photo' : `${photos.length} photos`
        }.`,
      );
    }),
    vscode.commands.registerCommand('polaroica.openTag', async (arg?: unknown) => {
      const tag = typeof arg === 'string' ? arg : arg instanceof TagNode ? arg.tag : undefined;
      if (tag) {
        grids.openSource(new TagSource(tag, tagIndex, libraries));
        return;
      }
      const counts = await tagIndex.allTags();
      if (!counts.length) {
        void vscode.window.showInformationMessage('No tags yet. Right-click a library and choose "Find Documents and Screenshots".');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        counts.map((c) => ({ label: c.tag, description: `${c.photos.toLocaleString()} photos` })),
        { title: 'Show photos tagged…' },
      );
      if (pick) {
        grids.openSource(new TagSource(pick.label, tagIndex, libraries));
      }
    }),
    vscode.commands.registerCommand('polaroica.openFolder', (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        grids.open(uri);
      }
    }),
    vscode.commands.registerCommand('polaroica.moveTo', async (node?: TreeNode, nodes?: TreeNode[]) => {
      const picked = (nodes?.length ? nodes : node ? [node] : [...view.selection]).filter(
        (n): n is FolderNode => n instanceof FolderNode,
      );
      await mover.moveWithPicker(picked.map((n) => n.uri));
    }),
    vscode.commands.registerCommand('polaroica.newFolder', async (arg?: unknown) => {
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
    ...(['move', 'reveal', 'export', 'copyPath'] as const).map((action) =>
      vscode.commands.registerCommand(
        {
          move: 'polaroica.photoMoveTo',
          reveal: 'polaroica.photoReveal',
          export: 'polaroica.photoExport',
          copyPath: 'polaroica.photoCopyPath',
        }[action],
        async (ctx?: { webview?: string; photo?: string }) => {
          if (ctx?.webview === 'polaroica.grid') {
            await grids.contextAction(action, ctx.photo);
          } else if (ctx?.webview === 'polaroica.photo') {
            await viewers.contextAction(action);
          }
        },
      ),
    ),
    vscode.commands.registerCommand('polaroica.revealInOS', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await vscode.commands.executeCommand('revealFileInOS', uri);
      }
    }),
    vscode.commands.registerCommand('polaroica.copyPath', async (arg?: unknown) => {
      const uri = uriOf(arg);
      if (uri) {
        await vscode.env.clipboard.writeText(uri.fsPath);
      }
    }),
  );
}

export function deactivate(): void {
  disposeCodecs();
}

/** Each photo's tags, in the order given. */
async function tagsOfAll(edits: EditStore, photos: vscode.Uri[]): Promise<string[][]> {
  return Promise.all(photos.map((u) => edits.tagsOf(u)));
}

/** "on 3 of 7" for a tag part of the selection carries, undefined when none of it does. */
function onHowMany(have: string[][], tag: string, total: number): string | undefined {
  const n = have.filter((ts) => ts.some((t) => t.toLowerCase() === tag.toLowerCase())).length;
  if (!n) {
    return undefined;
  }
  return n === total ? (total === 1 ? 'on this photo' : 'on all of them') : `on ${n} of ${total}`;
}
