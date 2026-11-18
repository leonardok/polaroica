import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './core/images';
import { DeleteItem, planRejectDelete } from './core/trash';
import { SIDECAR_DIR } from './core/xmp';
import { EditStore } from './edits';
import { Libraries } from './libraries';
import { PhotoStore } from './photoStore';

/** Deletes rejected photos from disk: to the Trash when the volume has one, else permanently (asked first). */
export class Deleter {
  constructor(
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly edits: EditStore,
  ) {}

  async deleteRejected(folder: vscode.Uri): Promise<void> {
    const where = this.libraries.crumbs(folder).join(' / ');
    const [photos, culling] = await Promise.all([this.store.photos(folder), this.edits.cullingIn(folder.fsPath)]);
    const plan = planRejectDelete(folder.fsPath, photos, culling);
    const n = plan.items.length;
    if (!n) {
      void vscode.window.showInformationMessage(`No rejected photos in ${where}.`);
      return;
    }
    const what = n === 1 ? plan.items[0].name : `${n} rejected photos`;
    const sample = plan.items.slice(0, 5).map((i) => i.name).join(', ') + (n > 5 ? `, and ${n - 5} more` : '');
    const go = await vscode.window.showWarningMessage(
      `Delete ${what} from ${where}?`,
      {
        modal: true,
        detail: `${sample}\n\n${formatBytes(plan.bytes)}. They go to the Trash, with their ratings and edits.`,
      },
      'Move to Trash',
    );
    if (go !== 'Move to Trash') {
      return;
    }

    let useTrash = true;
    let trashed = 0;
    let removed = 0;
    const failed: string[] = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting ${what}`, cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < n; i++) {
          if (token.isCancellationRequested) {
            break;
          }
          const item = plan.items[i];
          progress.report({ message: `${i + 1} of ${n} · ${item.name}`, increment: 100 / n });
          try {
            await deleteOne(item, useTrash);
            if (useTrash) trashed++;
            else removed++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const gone = err instanceof vscode.FileSystemError && err.code === 'FileNotFound';
            if (useTrash && !gone) {
              // Network shares usually have no Trash: offer to delete the rest for good.
              const left = n - i;
              const permanent = await vscode.window.showWarningMessage(
                `Can't move ${item.name} to the Trash: ${msg}`,
                {
                  modal: true,
                  detail: `${where} may not have a Trash (network shares usually don't). Delete the remaining ${left === 1 ? 'photo' : `${left} photos`} permanently? This can't be undone.`,
                },
                'Delete Permanently',
              );
              if (permanent !== 'Delete Permanently') {
                break;
              }
              useTrash = false;
              i--; // retry this one
              continue;
            }
            failed.push(`${item.name}: ${msg}`);
          }
        }
      },
    );

    await fs.promises.rmdir(path.join(folder.fsPath, SIDECAR_DIR)).catch(() => undefined); // only when empty
    this.edits.forget(folder.fsPath);
    this.store.invalidate(folder);

    const parts: string[] = [];
    if (trashed) parts.push(`moved ${trashed === 1 ? '1 photo' : `${trashed} photos`} to the Trash`);
    if (removed) parts.push(`deleted ${removed === 1 ? '1 photo' : `${removed} photos`} permanently`);
    if (parts.length) {
      const text = parts.join(', ');
      void vscode.window.showInformationMessage(`${where}: ${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
    }
    if (failed.length) {
      void vscode.window.showErrorMessage(`Could not delete ${failed.length === 1 ? '1 photo' : `${failed.length} photos`}: ${failed.slice(0, 3).join('; ')}`);
    }
  }
}

/** The photo first, then its sidecar: a photo that couldn't be deleted keeps its ratings. */
async function deleteOne(item: DeleteItem, useTrash: boolean): Promise<void> {
  await vscode.workspace.fs.delete(vscode.Uri.file(item.photo), { useTrash });
  try {
    await vscode.workspace.fs.delete(vscode.Uri.file(item.sidecar), { useTrash });
  } catch {
    // No sidecar, or the Trash refused a tiny file: drop it so no orphan rating is left.
    await fs.promises.rm(item.sidecar, { force: true }).catch(() => undefined);
  }
}
