import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { nextFreeName } from './core/images';
import { Libraries } from './libraries';
import { PhotoStore } from './photoStore';
import { thumbPx } from './thumbs';
import { EditStore } from './edits';

const RECENT_TARGETS = 'vsphoto.recentMoveTargets';

export interface MoveResult {
  moved: Array<{ from: vscode.Uri; to: vscode.Uri }>;
  skipped: vscode.Uri[];
}

export class Mover {
  private readonly moved = new vscode.EventEmitter<MoveResult>();
  readonly onDidMove = this.moved.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly edits?: EditStore,
  ) {}

  /** "Move to…": pick a destination, then move. */
  async moveWithPicker(files: vscode.Uri[]): Promise<void> {
    if (!files.length) {
      return;
    }
    const start = path.dirname(files[0].fsPath);
    const target = await this.pickFolder(files.length, vscode.Uri.file(start));
    if (target) {
      await this.move(files, target);
    }
  }

  async move(files: vscode.Uri[], target: vscode.Uri): Promise<MoveResult> {
    const result: MoveResult = { moved: [], skipped: [] };
    const label = this.libraries.crumbs(target).join(' / ');
    const what = files.length === 1 ? path.basename(files[0].fsPath) : `${files.length} items`;
    let onConflict: 'ask' | 'skip' | 'keepBoth' = 'ask';

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Moving ${what} to ${label}`, cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < files.length; i++) {
          if (token.isCancellationRequested) {
            break;
          }
          const src = files[i];
          const name = path.basename(src.fsPath);
          progress.report({ message: `${i + 1} of ${files.length} · ${name}`, increment: 100 / files.length });

          if (isInside(target.fsPath, src.fsPath)) {
            void vscode.window.showWarningMessage(`Can't move ${name} into itself.`);
            result.skipped.push(src);
            continue;
          }
          let dest = vscode.Uri.file(path.join(target.fsPath, name));
          if (await exists(dest.fsPath)) {
            let choice = onConflict;
            if (choice === 'ask') {
              const keep = 'Keep Both';
              const skip = 'Skip';
              const keepAll = 'Keep Both for All';
              const skipAll = 'Skip All';
              const picked = await vscode.window.showWarningMessage(
                `${name} already exists in ${label}.`,
                { modal: true },
                keep,
                skip,
                ...(files.length > 1 ? [keepAll, skipAll] : []),
              );
              if (!picked) {
                break; // cancelled the whole move
              }
              if (picked === keepAll) {
                onConflict = 'keepBoth';
              } else if (picked === skipAll) {
                onConflict = 'skip';
              }
              choice = picked === keep || picked === keepAll ? 'keepBoth' : 'skip';
            }
            if (choice === 'skip') {
              result.skipped.push(src);
              continue;
            }
            const taken = new Set(await fs.promises.readdir(target.fsPath));
            dest = vscode.Uri.file(path.join(target.fsPath, nextFreeName(name, (n) => taken.has(n))));
          }
          try {
            const before = await fs.promises.stat(src.fsPath).catch(() => undefined);
            await moveOne(src, dest);
            result.moved.push({ from: src, to: dest });
            if (before?.isFile()) {
              await this.carryThumbnail(src, dest, before);
              // The photo's edits (.sidecar/<name>.xmp) go with it.
              await this.edits?.carry(src, dest).catch(() => undefined);
            }
          } catch (err) {
            result.skipped.push(src);
            const msg = err instanceof Error ? err.message : String(err);
            const go = await vscode.window.showErrorMessage(`Could not move ${name}: ${msg}`, 'Continue', 'Stop');
            if (go !== 'Continue') {
              break;
            }
          }
        }
      },
    );

    const touched = new Set<string>([target.fsPath]);
    for (const m of result.moved) {
      touched.add(path.dirname(m.from.fsPath));
    }
    for (const f of touched) {
      this.store.invalidate(vscode.Uri.file(f));
    }
    await this.rememberTarget(target);
    this.moved.fire(result);

    if (result.moved.length) {
      const n = result.moved.length;
      void vscode.window.showInformationMessage(
        `Moved ${n === 1 ? path.basename(result.moved[0].to.fsPath) : `${n} items`} to ${label}` +
          (result.skipped.length ? ` (${result.skipped.length} skipped)` : ''),
      );
    }
    return result;
  }

  /** Moves the cached thumbnail with the photo, so it is not generated again. */
  private async carryThumbnail(src: vscode.Uri, dest: vscode.Uri, before: fs.Stats): Promise<void> {
    try {
      const after = await fs.promises.stat(dest.fsPath);
      await this.store.cache.moveThumb(
        { folder: path.dirname(src.fsPath), name: path.basename(src.fsPath), size: before.size, mtime: Math.round(before.mtimeMs) },
        { folder: path.dirname(dest.fsPath), name: path.basename(dest.fsPath), size: after.size, mtime: Math.round(after.mtimeMs) },
        thumbPx(),
      );
    } catch {
      /* the thumbnail will simply be made again */
    }
  }

  /** Folder picker that walks the libraries one level at a time (no full scan of a share). */
  private async pickFolder(count: number, start: vscode.Uri): Promise<vscode.Uri | undefined> {
    const recents = this.context.globalState
      .get<string[]>(RECENT_TARGETS, [])
      .filter((p) => this.libraries.libraryOf(vscode.Uri.file(p)));

    type Item = vscode.QuickPickItem & { action: 'here' | 'up' | 'open' | 'new' | 'libs'; uri?: vscode.Uri };
    const qp = vscode.window.createQuickPick<Item>();
    qp.title = `Move ${count === 1 ? '1 item' : `${count} items`} to…`;
    qp.matchOnDescription = true;

    let current: vscode.Uri | undefined = this.libraries.libraryOf(start) ? start : undefined;

    const load = async () => {
      qp.busy = true;
      const items: Item[] = [];
      if (!current) {
        qp.placeholder = 'Choose a library';
        if (recents.length) {
          items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator, action: 'open' });
          for (const r of recents) {
            const u = vscode.Uri.file(r);
            items.push({ label: `$(history) ${path.basename(r)}`, description: this.libraries.crumbs(u).join(' / '), action: 'open', uri: u });
          }
          items.push({ label: 'Libraries', kind: vscode.QuickPickItemKind.Separator, action: 'open' });
        }
        for (const lib of this.libraries.all) {
          items.push({
            label: `$(${this.libraries.kind(lib) === 'smb' ? 'server' : 'device-desktop'}) ${lib.name}`,
            description: lib.uri.fsPath,
            action: 'open',
            uri: lib.uri,
          });
        }
      } else {
        const crumbs = this.libraries.crumbs(current).join(' / ');
        qp.placeholder = `In ${crumbs} — type to filter folders`;
        items.push({ label: `$(check) Move here`, description: crumbs, action: 'here', uri: current });
        items.push({ label: `$(arrow-up) Up`, action: 'up' });
        items.push({ label: `$(new-folder) New folder…`, action: 'new' });
        try {
          const { folders } = await this.store.listing(current);
          if (folders.length) {
            items.push({ label: 'Folders', kind: vscode.QuickPickItemKind.Separator, action: 'open' });
          }
          for (const f of folders) {
            items.push({ label: `$(folder) ${f}`, action: 'open', uri: vscode.Uri.file(path.join(current.fsPath, f)) });
          }
        } catch (err) {
          items.push({ label: `$(warning) Can't read this folder`, detail: String(err), action: 'up' });
        }
      }
      qp.value = '';
      qp.items = items;
      qp.busy = false;
    };

    return new Promise((resolve) => {
      let settled = false;
      let suspended = false; // while the "New folder" input box is up, the picker is hidden
      const finish = (v: vscode.Uri | undefined) => {
        if (!settled) {
          settled = true;
          resolve(v);
          qp.dispose();
        }
      };
      qp.onDidAccept(async () => {
        const item = qp.selectedItems[0];
        if (!item) {
          return;
        }
        switch (item.action) {
          case 'here':
            finish(item.uri);
            return;
          case 'up': {
            if (!current) {
              return;
            }
            const lib = this.libraries.libraryOf(current);
            current = lib && lib.uri.fsPath === current.fsPath ? undefined : vscode.Uri.file(path.dirname(current.fsPath));
            await load();
            return;
          }
          case 'new': {
            const typed = qp.value.trim();
            suspended = true;
            const name = await vscode.window.showInputBox({
              title: 'New folder',
              value: typed,
              validateInput: (v) => (/[\\/:*?"<>|]/.test(v) ? 'Name contains characters not allowed in file names' : undefined),
            });
            suspended = false;
            if (name && current) {
              const dir = vscode.Uri.file(path.join(current.fsPath, name));
              await vscode.workspace.fs.createDirectory(dir);
              this.store.invalidate(current);
              finish(dir);
            } else {
              qp.show();
            }
            return;
          }
          case 'open':
            if (item.uri) {
              current = item.uri;
              await load();
            }
            return;
        }
      });
      qp.onDidHide(() => {
        if (!suspended) {
          finish(undefined);
        }
      });
      qp.show();
      void load();
    });
  }

  private async rememberTarget(target: vscode.Uri): Promise<void> {
    const list = this.context.globalState.get<string[]>(RECENT_TARGETS, []);
    await this.context.globalState.update(
      RECENT_TARGETS,
      [target.fsPath, ...list.filter((p) => p !== target.fsPath)].slice(0, 5),
    );
  }
}

/** Rename when possible; across libraries (different volumes) copy, verify size, then delete. */
async function moveOne(src: vscode.Uri, dest: vscode.Uri): Promise<void> {
  try {
    await fs.promises.rename(src.fsPath, dest.fsPath);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EINVAL') {
      throw err;
    }
  }
  await vscode.workspace.fs.copy(src, dest, { overwrite: false });
  const [a, b] = await Promise.all([sizeOf(src.fsPath), sizeOf(dest.fsPath)]);
  if (a !== b) {
    await vscode.workspace.fs.delete(dest, { recursive: true, useTrash: false }).then(undefined, () => undefined);
    throw new Error('copy could not be verified (size differs); the original was kept');
  }
  await vscode.workspace.fs.delete(src, { recursive: true, useTrash: false });
}

async function sizeOf(p: string): Promise<number> {
  const st = await fs.promises.stat(p);
  if (!st.isDirectory()) {
    return st.size;
  }
  let total = 0;
  for (const e of await fs.promises.readdir(p)) {
    total += await sizeOf(path.join(p, e));
  }
  return total;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
