import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { formatBytes } from './core/images';
import { DeleteItem, DeletePlan, planPhotoDelete, planRejectDelete, runDeletes } from './core/trash';
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
    await this.confirmAndDelete(plan, where, what, [folder]);
  }

  /** Right-click → Delete on a selection of photos, which may span folders. */
  async deletePhotos(uris: ReadonlyArray<vscode.Uri>): Promise<void> {
    if (!uris.length) {
      return;
    }
    const files = await Promise.all(
      uris.map(async (u) => ({
        path: u.fsPath,
        size: await fs.promises
          .stat(u.fsPath)
          .then((st) => st.size)
          .catch(() => 0),
      })),
    );
    const plan = planPhotoDelete(files);
    const folders = [...new Set(files.map((f) => path.dirname(f.path)))].map((f) => vscode.Uri.file(f));
    const where = folders.length === 1 ? this.libraries.crumbs(folders[0]).join(' / ') : `${folders.length} folders`;
    const n = plan.items.length;
    const what = n === 1 ? plan.items[0].name : `${n} photos`;
    await this.confirmAndDelete(plan, where, what, folders);
  }

  /** Asks first, then deletes: to the Trash where there is one, else permanently. */
  private async confirmAndDelete(
    plan: DeletePlan,
    where: string,
    what: string,
    folders: ReadonlyArray<vscode.Uri>,
  ): Promise<void> {
    const n = plan.items.length;
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

    let out = { trashed: 0, removed: 0, failed: [] as string[] };
    const gone = new Set<string>();
    // One refresh at the end: every delete makes the watcher report the photo and its sidecar,
    // and refreshing per report costs more than the deleting does.
    const resume = this.store.holdChanges();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Deleting ${what}`, cancellable: true },
      async (progress, token) => {
        out = await runDeletes(plan.items, {
          delete: async (item, useTrash) => {
            await deleteOne(item, useTrash);
            gone.add(item.name);
          },
          isGone: (err) => err instanceof vscode.FileSystemError && err.code === 'FileNotFound',
          progress: (done, item) => progress.report({ message: `${done} of ${n} · ${item.name}`, increment: 100 / n }),
          cancelled: () => token.isCancellationRequested,
          askPermanent: async (item, message, left) => {
            const permanent = await vscode.window.showWarningMessage(
              `Can't move ${item.name} to the Trash: ${message}`,
              {
                modal: true,
                detail: `${where} may not have a Trash (network shares usually don't). Delete the remaining ${left === 1 ? 'photo' : `${left} photos`} permanently? This can't be undone.`,
              },
              'Delete Permanently',
            );
            return permanent === 'Delete Permanently';
          },
        });
      },
    );
    const { trashed, removed, failed } = out;

    try {
      for (const folder of folders) {
        await fs.promises.rmdir(path.join(folder.fsPath, SIDECAR_DIR)).catch(() => undefined); // only when empty
        this.edits.forget(folder.fsPath);
        const here = new Set(
          plan.items.filter((i) => path.dirname(i.photo) === folder.fsPath && gone.has(i.name)).map((i) => i.name),
        );
        await this.store.forgetPhotos(folder, here);
      }
    } finally {
      resume();
    }

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
