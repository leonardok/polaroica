import * as path from 'path';
import * as vscode from 'vscode';
import { Libraries } from './libraries';
import { isReachable, mapLimit, PhotoStore } from './photoStore';

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

export type TreeNode = LibraryNode | FolderNode;

/** The "Libraries" view: libraries (workspace folders) as roots, sub-folders below. */
export class LibraryTree implements vscode.TreeDataProvider<TreeNode>, vscode.TreeDragAndDropController<TreeNode> {
  private readonly changed = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;

  readonly dropMimeTypes = [TREE_MIME, 'text/uri-list'];
  readonly dragMimeTypes = ['text/uri-list'];

  /** What we know about a folder's contents: photo count and whether it has sub-folders. */
  private readonly info = new Map<string, { photos: number; subfolders: number; picks?: number }>();
  /** Set by the extension: pick counts per album (from the sidecars). */
  picksIn?: (folder: string) => Promise<number>;
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

  /** An album's picks changed: redraw its row. */
  async picksChanged(folder: string): Promise<void> {
    const i = this.info.get(folder);
    const node = this.nodes.get(folder);
    if (i && node && this.picksIn) {
      i.picks = await this.picksIn(folder).catch(() => 0);
      this.changed.fire(node);
    }
  }

  refresh(): void {
    this.offline.clear();
    this.store.invalidate();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const showCounts = vscode.workspace.getConfiguration('polaroica').get<boolean>('showPhotoCounts', true);
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
        : kind === 'smb'
          ? new vscode.ThemeIcon('server', new vscode.ThemeColor('charts.green'))
          : new vscode.ThemeIcon('device-desktop', new vscode.ThemeColor('charts.blue'));
      item.contextValue = isOffline ? 'library.offline' : 'library';
      if (!isOffline) {
        item.command = { command: 'polaroica.openFolder', title: 'Open', arguments: [node.uri] };
      }
      return item;
    }
    const name = path.basename(node.uri.fsPath);
    const info = this.info.get(node.uri.fsPath);
    // A folder without sub-folders is an album: a leaf (no twistie) with an album icon.
    const leaf = info !== undefined && info.subfolders === 0;
    const album = leaf && info.photos > 0;
    const item = new vscode.TreeItem(
      name,
      leaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = 'dir:' + node.uri.toString();
    item.iconPath = album ? new vscode.ThemeIcon('file-media') : vscode.ThemeIcon.Folder;
    item.resourceUri = node.uri;
    item.contextValue = 'folder';
    item.tooltip = node.uri.fsPath;
    if (showCounts && info?.photos) {
      item.description = info.photos.toLocaleString() + (info.picks ? ` · ${info.picks} ✓` : '');
    }
    item.command = { command: 'polaroica.openFolder', title: 'Open', arguments: [node.uri] };
    return item;
  }

  getParent(node: TreeNode): TreeNode | undefined {
    return node instanceof FolderNode ? node.parent : undefined;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
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
      return libs;
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
        const picks = this.picksIn ? await this.picksIn(c.uri.fsPath).catch(() => 0) : 0;
        this.info.set(c.uri.fsPath, { photos: listing.photos.length, subfolders: listing.folders.length, picks });
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
    if (!target) {
      return;
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
