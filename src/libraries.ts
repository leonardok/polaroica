import * as path from 'path';
import * as vscode from 'vscode';
import {
  candidateLocalPaths,
  defaultLibraryName,
  formatUnc,
  looksLikeNetworkPath,
  parseSmbAddress,
} from './core/smb';
import { isReachable } from './photoStore';

const NETWORK_KEY = 'polaroica.networkLibraries';
const RECENT_KEY = 'polaroica.recentShares';

export type LibraryKind = 'local' | 'smb';

/** A library is a workspace folder. This class adds what VS Code does not track: its kind. */
export class Libraries {
  constructor(private readonly context: vscode.ExtensionContext) {}

  get all(): readonly vscode.WorkspaceFolder[] {
    return vscode.workspace.workspaceFolders ?? [];
  }

  kind(folder: vscode.WorkspaceFolder): LibraryKind {
    const marked = this.context.globalState.get<string[]>(NETWORK_KEY, []);
    if (marked.includes(normalize(folder.uri.fsPath))) {
      return 'smb';
    }
    return looksLikeNetworkPath(folder.uri.fsPath, process.platform) ? 'smb' : 'local';
  }

  /** The library a file or folder belongs to. */
  libraryOf(uri: vscode.Uri): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.getWorkspaceFolder(uri);
  }

  /** ["NAS · photos", "Archive", "2026"] for a folder. */
  crumbs(uri: vscode.Uri): string[] {
    const lib = this.libraryOf(uri);
    if (!lib) {
      return uri.fsPath.split(/[\\/]/).filter(Boolean);
    }
    const rel = path.relative(lib.uri.fsPath, uri.fsPath);
    return [lib.name, ...rel.split(/[\\/]/).filter(Boolean)];
  }

  async add(): Promise<void> {
    const local: vscode.QuickPickItem = {
      label: '$(device-desktop) Local folder…',
      detail: 'A folder on this computer or an already-mounted drive',
    };
    const network: vscode.QuickPickItem = {
      label: '$(server) Network share (SMB)…',
      detail: 'A NAS or Windows share your computer can already reach',
    };
    const choice = await vscode.window.showQuickPick([local, network], {
      title: 'Add Photo Library (1/2)',
      placeHolder: 'Where are the photos?',
    });
    if (choice === local) {
      await this.addLocal();
    } else if (choice === network) {
      await this.addNetwork();
    }
  }

  private async addLocal(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      title: 'Add Photo Library (2/2): choose a folder',
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Add Library',
    });
    if (picked?.[0]) {
      await this.addFolder(picked[0], path.basename(picked[0].fsPath) || picked[0].fsPath, 'local');
    }
  }

  private async addNetwork(): Promise<void> {
    const recent = this.context.globalState.get<string[]>(RECENT_KEY, []);
    const input = await this.pickShare(recent);
    if (!input) {
      return;
    }
    const addr = parseSmbAddress(input);
    let target: string | undefined;
    let name: string;
    if (addr) {
      const candidates = candidateLocalPaths(addr, {
        platform: process.platform,
        uid: typeof process.getuid === 'function' ? process.getuid() : undefined,
      });
      for (const c of candidates) {
        if (await isReachable(c)) {
          target = c;
          break;
        }
      }
      name = defaultLibraryName(addr);
      if (process.platform === 'win32' && !(await this.allowUncHost(addr.host))) {
        return;
      }
      if (!target) {
        const browse = 'Choose Mounted Folder…';
        const res = await vscode.window.showWarningMessage(
          `Can't reach ${formatUnc(addr)}. Connect to the share in your file manager (or mount it) first, then try again.`,
          { modal: false, detail: `Looked in: ${candidates.join(', ')}` },
          browse,
        );
        if (res === browse) {
          const picked = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Add Library',
          });
          target = picked?.[0]?.fsPath;
        }
      }
    } else {
      // A path where the share is already mounted, e.g. /Volumes/photos or Z:\
      target = input.trim();
      name = path.basename(target) || target;
      if (!(await isReachable(target))) {
        void vscode.window.showErrorMessage(`Folder not found: ${target}`);
        return;
      }
    }
    if (!target) {
      return;
    }
    await this.context.globalState.update(
      RECENT_KEY,
      [input.trim(), ...recent.filter((r) => r !== input.trim())].slice(0, 8),
    );
    await this.addFolder(vscode.Uri.file(target), name, 'smb');
  }

  /**
   * Since VS Code 1.78, Windows builds only touch UNC paths on hosts listed in
   * `security.allowedUNCHosts`. Offer to add the NAS there.
   */
  private async allowUncHost(host: string): Promise<boolean> {
    const security = vscode.workspace.getConfiguration('security');
    if (security.get<boolean>('restrictUNCAccess', true) === false) {
      return true;
    }
    const allowed = security.get<string[]>('allowedUNCHosts', []);
    if (allowed.some((h) => h.toLowerCase() === host.toLowerCase())) {
      return true;
    }
    const allow = `Allow ${host}`;
    const res = await vscode.window.showWarningMessage(
      `VS Code only opens network paths on hosts you allow. Allow "${host}"?`,
      { modal: true, detail: 'This adds the host to the security.allowedUNCHosts setting. VS Code may ask you to restart.' },
      allow,
    );
    if (res !== allow) {
      return false;
    }
    await security.update('allowedUNCHosts', [...allowed, host], vscode.ConfigurationTarget.Global);
    return true;
  }

  private pickShare(recent: string[]): Promise<string | undefined> {
    return new Promise((resolve) => {
      const qp = vscode.window.createQuickPick();
      qp.title = 'Network share address (2/2)';
      qp.placeholder = process.platform === 'win32' ? '\\\\nas.local\\photos' : 'smb://nas.local/photos';
      qp.items = recent.map((r) => ({ label: r, description: 'recently used' }));
      let done = false;
      const finish = (v: string | undefined) => {
        if (!done) {
          done = true;
          resolve(v);
          qp.dispose();
        }
      };
      qp.onDidChangeValue((v) => {
        const typed = v.trim() ? [{ label: v.trim(), description: parseSmbAddress(v) ? 'SMB share' : 'mounted path' }] : [];
        qp.items = [...typed, ...recent.filter((r) => r !== v.trim()).map((r) => ({ label: r, description: 'recently used' }))];
      });
      qp.onDidAccept(() => finish(qp.selectedItems[0]?.label ?? (qp.value.trim() || undefined)));
      qp.onDidHide(() => finish(undefined));
      qp.show();
    });
  }

  private async addFolder(uri: vscode.Uri, name: string, kind: LibraryKind): Promise<void> {
    if (this.all.some((f) => normalize(f.uri.fsPath) === normalize(uri.fsPath))) {
      void vscode.window.showInformationMessage(`${name} is already a library.`);
      return;
    }
    if (kind === 'smb') {
      const marked = this.context.globalState.get<string[]>(NETWORK_KEY, []);
      await this.context.globalState.update(NETWORK_KEY, [...new Set([...marked, normalize(uri.fsPath)])]);
    }
    const ok = vscode.workspace.updateWorkspaceFolders(this.all.length, 0, { uri, name });
    if (!ok) {
      void vscode.window.showErrorMessage(`Could not add ${name} to the workspace.`);
    } else if (!vscode.workspace.workspaceFile) {
      void vscode.window.showInformationMessage(
        'Tip: save this window as a workspace (File › Save Workspace As…) to keep your libraries together.',
      );
    }
  }

  async remove(folder: vscode.WorkspaceFolder): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Remove library "${folder.name}"? Its photos are not deleted.`,
      { modal: true },
      'Remove',
    );
    if (ok === 'Remove') {
      vscode.workspace.updateWorkspaceFolders(folder.index, 1);
    }
  }
}

function normalize(p: string): string {
  const n = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}
