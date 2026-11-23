import * as path from 'path';
import * as vscode from 'vscode';
import { albumStats } from './core/albumStats';
import { Libraries } from './libraries';
import { isReachable, mapLimit, PhotoStore } from './photoStore';
import { TagIndex } from './tagIndex';

export const TREE_MIME = 'application/vnd.code.tree.polaroica.libraries';

export class LibraryNode {
  readonly type = 'library';
  constructor(readonly folder: vscode.WorkspaceFolder) {}
  get uri(): vscode.Uri {
    return this.folder.uri;
  }
}

export class FolderNode {
  readonly type = 'folder';
  constructor(readonly uri: vscode.Uri, readonly parent: TreeNode) {}
}

/** The "Tags" row: holds one child per tag in use. Shown only once something is tagged. */
export class TagsRootNode {
  readonly type = 'tags';
}

/** One tag: opens a grid of every photo carrying it, from every library. */
export class TagNode {
  readonly type = 'tag';
  constructor(
    readonly tag: string,
    readonly photos: number,
  ) {}
}

export type TreeNode = LibraryNode | FolderNode | TagsRootNode | TagNode;

/** The "Libraries" view: libraries (workspace folders) as roots, sub-folders below. */
export class LibraryTree implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];

  /** What we know about a folder's contents: photo count and whether it has sub-folders. */
  private readonly info = new Map<string, { photos: number; subfolders: number }>();
  /** Set by the extension: ratings and flags of an album's photos (from the sidecars), for the hover. */
  cullingIn?: (folder: string) => Promise<ReadonlyMap<string, { rating: number; flag?: string; edited: boolean; auto?: unknown }>>;
  /** Set by the extension: the media folder, for the tree's own icons. */
  media?: vscode.Uri;
  /** Set by the extension: which photos carry which tags, for the "Tags" rows. */
  tags?: TagIndex;
  private readonly offline = new Set<string>();
  private readonly nodes = new Map<string, FolderNode>();

  constructor(
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly onDropFiles: (files: vscode.Uri[], target: vscode.Uri) => Promise<void>,
  ) {
    store.onDidChange((folder) => {
      if (!folder) {
        this.info.clear();
        this.changed.fire(undefined);
        return;
      }
      this.info.delete(folder.fsPath);
      // Refresh the parent so the folder's own row (count) and its children are redrawn.
      const node = this.nodes.get(folder.fsPath);
      this.changed.fire(node ? node.parent : undefined);
    });
  }

  /** Tags were added or removed: redraw the "Tags" rows. */
  tagsChanged(): void {
    this.changed.fire(undefined);
  }

  /** An album's ratings or flags changed: redraw its row so the hover is made again. */
  cullingChanged(folder: string): void {
    const node = this.nodes.get(folder);
    if (node && this.info.has(folder)) {
      this.changed.fire(node);
    }
  }

  /** One of the tree's own icons (media/<name>-light.svg and -dark.svg). */
  private icon(name: string): vscode.TreeItem['iconPath'] {
    if (!this.media) {
      return new vscode.ThemeIcon(name === 'library-smb' ? 'server' : name === 'library-local' ? 'device-desktop' : 'file-media');
    }
    return {
      light: vscode.Uri.joinPath(this.media, `${name}-light.svg`),
      dark: vscode.Uri.joinPath(this.media, `${name}-dark.svg`),
    };
  }

  refresh(): void {
    this.offline.clear();
    this.store.invalidate();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const showCounts = vscode.workspace.getConfiguration('polaroica').get<boolean>('showPhotoCounts', true);
    if (node instanceof TagsRootNode) {
      const item = new vscode.TreeItem('Tags', vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'tags';
      item.iconPath = new vscode.ThemeIcon('tag');
      item.contextValue = 'tags';
      item.tooltip = 'Keywords on your photos. Right-click a library to look for documents and screenshots.';
      return item;
    }
    if (node instanceof TagNode) {
      const item = new vscode.TreeItem(node.tag, vscode.TreeItemCollapsibleState.None);
      item.id = 'tag:' + node.tag.toLowerCase();
      item.iconPath = new vscode.ThemeIcon('tag');
      item.contextValue = 'tag';
      if (showCounts) {
        item.description = node.photos.toLocaleString();
      }
      item.tooltip = `${node.photos.toLocaleString()} photo${node.photos === 1 ? '' : 's'} tagged ${node.tag}`;
      item.command = { command: 'polaroica.openTag', title: 'Open', arguments: [node.tag] };
      return item;
    }
    if (node instanceof LibraryNode) {
      const kind = this.libraries.kind(node.folder);
      const isOffline = this.offline.has(node.uri.fsPath);
      const item = new vscode.TreeItem(
        node.folder.name,
        isOffline ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Expanded,
      );
      item.id = 'lib:' + node.uri.toString();
      item.description = isOffline ? 'offline' : kind;
      item.tooltip = new vscode.MarkdownString(
        `**${node.folder.name}**\n\n${node.uri.fsPath}\n\n${kind === 'smb' ? 'Network share (SMB)' : 'Local folder'}${isOffline ? ' — not reachable' : ''}`,
      );
      item.iconPath = isOffline
        ? new vscode.ThemeIcon('debug-disconnect', new vscode.ThemeColor('list.warningForeground'))
        : this.icon(kind === 'smb' ? 'library-smb' : 'library-local');
      item.contextValue = isOffline ? 'library.offline' : 'library';
      if (!isOffline) {
        item.command = { command: 'polaroica.openFolder', title: 'Open', arguments: [node.uri] };
      }
      return item;
    }
    const name = path.basename(node.uri.fsPath);
    const info = this.info.get(node.uri.fsPath);
    // A folder with photos is an album, whether or not it also has sub-folders (nested albums).
    // Only folders with sub-folders get a twistie.
    const leaf = info !== undefined && info.subfolders === 0;
    const album = info !== undefined && info.photos > 0;
    const item = new vscode.TreeItem(
      name,
      leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = 'dir:' + node.uri.toString();
    item.iconPath = album ? this.icon('album') : new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.yellow'));
    item.resourceUri = node.uri;
    item.contextValue = 'folder';
    // The hover (photos, picks, rejects, still to cull…) is made when it's shown: resolveTreeItem.
    if (showCounts && info?.photos) {
      item.description = info.photos.toLocaleString();
    }
    item.command = { command: 'polaroica.openFolder', title: 'Open', arguments: [node.uri] };
    return item;
  }

  /** The album hover, made when it's about to show (reads the listing and sidecars: cached, quick). */
  async resolveTreeItem(item: vscode.TreeItem, node: TreeNode): Promise<vscode.TreeItem> {
    if (!(node instanceof FolderNode)) {
      return item;
    }
    const name = path.basename(node.uri.fsPath);
    const md = new vscode.MarkdownString('', true);
    md.appendMarkdown(`**${escapeMd(name)}**\n\n`);
    try {
      const listing = await this.store.listing(node.uri);
      const names = listing.photos.map((p) => p.name);
      if (names.length) {
        const s = albumStats(names, this.cullingIn ? await this.cullingIn(node.uri.fsPath).catch(() => new Map()) : new Map());
        const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString()} ${n === 1 ? one : many}`;
        const kinds = ([[s.raw, 'RAW'], [s.jpeg, 'JPEG'], [s.other, 'other']] as const).filter(([n]) => n > 0);
        const kindText =
          kinds.length > 1 ? ` — ${kinds.map(([n, k]) => `${n.toLocaleString()} ${k}`).join(', ')}` : kinds.length && kinds[0][1] !== 'other' ? `, all ${kinds[0][1]}` : '';
        const lines = [
          `$(file-media) ${plural(s.photos, 'photo')}${kindText}`,
          [`$(check) ${plural(s.picks, 'pick')}`, `$(close) ${plural(s.rejects, 'reject')}`, `$(circle-large-outline) ${s.toCull.toLocaleString()} to cull`].join(' · '),
        ];
        const extra = [
          s.rated && `$(star-full) ${s.rated.toLocaleString()} with stars`,
          s.edited && `$(edit) ${s.edited.toLocaleString()} edited`,
          s.autoRanked && `$(sparkle) ${s.autoRanked.toLocaleString()} auto-ranked`,
        ].filter(Boolean);
        if (extra.length) lines.push(extra.join(' · '));
        md.appendMarkdown(lines.join('  \n') + '\n\n');
      }
      if (listing.folders.length) {
        md.appendMarkdown(`$(folder) ${listing.folders.length.toLocaleString()} ${listing.folders.length === 1 ? 'folder' : 'folders'} inside\n\n`);
      }
    } catch {
      md.appendMarkdown('$(warning) Can\'t read this folder right now\n\n');
    }
    md.appendMarkdown(`_${escapeMd(node.uri.fsPath)}_`);
    item.tooltip = md;
    return item;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    if (node instanceof TagNode) {
      return new TagsRootNode();
    }
    return node instanceof FolderNode ? node.parent : undefined;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node instanceof TagNode) {
      return [];
    }
    if (node instanceof TagsRootNode) {
      const counts = (await this.tags?.allTags()) ?? [];
      return counts.map((c) => new TagNode(c.tag, c.photos));
    }
    if (!node) {
      const libs = this.libraries.all.map((f) => new LibraryNode(f));
      // Check reachability in the background; a share that went away shows as offline.
      void Promise.all(
        libs.map(async (l) => {
          const ok = await isReachable(l.uri.fsPath);
          const was = this.offline.has(l.uri.fsPath);
          if (ok === was) {
            if (ok) {
              this.offline.delete(l.uri.fsPath);
            } else {
              this.offline.add(l.uri.fsPath);
            }
            this.changed.fire(l);
          }
        }),
      );
      // The "Tags" row only appears once something is tagged.
      const tagged = ((await this.tags?.allTags()) ?? []).length > 0;
      return tagged ? [...libs, new TagsRootNode()] : libs;
    }
    if (node instanceof LibraryNode && this.offline.has(node.uri.fsPath)) {
      return [];
    }
    let folders: string[];
    try {
      folders = (await this.store.listing(node.uri)).folders;
    } catch {
      if (node instanceof LibraryNode) {
        this.offline.add(node.uri.fsPath);
        this.changed.fire(node);
      }
      return [];
    }
    const children = folders.map((f) => {
      const child = new FolderNode(vscode.Uri.file(path.join(node.uri.fsPath, f)), node);
      this.nodes.set(child.uri.fsPath, child);
      return child;
    });
    // Know which children are albums before drawing them (instant from the local index); for
    // slow, never-seen folders don't hold the tree up: they update when their listing arrives.
    await Promise.race([this.loadInfo(children), new Promise((r) => setTimeout(r, 300))]);
    return children;
  }

  private async loadInfo(children: FolderNode[]): Promise<void> {
    const missing = children.filter((c) => !this.info.has(c.uri.fsPath));
    await mapLimit(missing, 4, async (c) => {
      try {
        const listing = await this.store.listing(c.uri);
        this.info.set(c.uri.fsPath, { photos: listing.photos.length, subfolders: listing.folders.length });
        this.changed.fire(c);
      } catch {
        /* unreadable folder: keep it expandable, no count */
      }
    });
  }

  // ---- drag and drop ------------------------------------------------------------------

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const folders = source.filter((s): s is FolderNode => s instanceof FolderNode);
    if (folders.length) {
      data.set('text/uri-list', new vscode.DataTransferItem(folders.map((f) => f.uri.toString()).join('\r\n')));
    }
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    if (!target || target instanceof TagsRootNode || target instanceof TagNode) {
      return; // a tag row is not a place on disk
    }
    const raw = await data.get('text/uri-list')?.asString();
    if (!raw) {
      return;
    }
    const files = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        try {
          return vscode.Uri.parse(l, true);
        } catch {
          return undefined;
        }
      })
      .filter((u): u is vscode.Uri => u?.scheme === 'file')
      .filter((u) => path.dirname(u.fsPath) !== target.uri.fsPath && u.fsPath !== target.uri.fsPath);
    if (files.length) {
      await this.onDropFiles(files, target.uri);
    }
  }
}

/** Text shown as-is in a Markdown hover: no formatting, links or $(icons) from a folder's name. */
export function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|$~]/g, '\\$&');
}
