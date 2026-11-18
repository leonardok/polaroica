import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultEdits, Edits, fromXmp, isDefault, SIDECAR_DIR, sidecarName, toXmp } from './core/xmp';

/**
 * Photo edits, kept next to the photos: `<folder>/.sidecar/<photo>.xmp`. The photo file itself is
 * never written. Saving default settings removes the sidecar (and the folder once it's empty).
 */
export class EditStore {
  /** Folder -> names of photos with a sidecar (one readdir per folder). */
  private readonly edited = new Map<string, Promise<Set<string>>>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  /** Fires with the photo whose edits changed. */
  readonly onDidChange = this.changed.event;
  /** Settings copied with "Copy Settings", shared by all photo tabs. */
  clipboard: Edits | undefined;

  sidecarPath(photo: vscode.Uri): string {
    return path.join(path.dirname(photo.fsPath), SIDECAR_DIR, sidecarName(path.basename(photo.fsPath)));
  }

  async load(photo: vscode.Uri): Promise<Edits | undefined> {
    try {
      return fromXmp(await fs.promises.readFile(this.sidecarPath(photo), 'utf8'));
    } catch {
      return undefined;
    }
  }

  async save(photo: vscode.Uri, edits: Edits): Promise<void> {
    const file = this.sidecarPath(photo);
    const dir = path.dirname(file);
    const names = await this.editedIn(path.dirname(photo.fsPath));
    const name = path.basename(photo.fsPath);
    if (isDefault(edits)) {
      await fs.promises.rm(file, { force: true });
      names.delete(name);
      await fs.promises.rmdir(dir).catch(() => undefined); // only succeeds when empty
    } else {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = file + '.tmp';
      await fs.promises.writeFile(tmp, toXmp(edits), 'utf8');
      await fs.promises.rename(tmp, file);
      names.add(name);
    }
    this.changed.fire(photo);
  }

  /** Names of photos in a folder that have edits. */
  editedIn(folder: string): Promise<Set<string>> {
    let p = this.edited.get(folder);
    if (!p) {
      p = fs.promises
        .readdir(path.join(folder, SIDECAR_DIR))
        .then((files) => new Set(files.filter((f) => f.endsWith('.xmp')).map((f) => f.slice(0, -4))))
        .catch(() => new Set<string>());
      this.edited.set(folder, p);
    }
    return p;
  }

  /** After a photo moved: its sidecar goes along (renamed if the photo was). */
  async carry(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    const src = this.sidecarPath(from);
    if (!(await exists(src))) {
      return;
    }
    const dest = this.sidecarPath(to);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.promises.rename(src, dest);
    } catch {
      await fs.promises.copyFile(src, dest);
      await fs.promises.rm(src, { force: true });
    }
    await fs.promises.rmdir(path.dirname(src)).catch(() => undefined);
    this.edited.delete(path.dirname(from.fsPath));
    this.edited.delete(path.dirname(to.fsPath));
  }

  forget(folder?: string): void {
    if (folder) {
      this.edited.delete(folder);
    } else {
      this.edited.clear();
    }
  }

  defaults(): Edits {
    return defaultEdits();
  }

  dispose(): void {
    this.changed.dispose();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.stat(p);
    return true;
  } catch {
    return false;
  }
}
