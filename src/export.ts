import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cpuCores } from './core/codec';
import { ExportPool } from './core/exporter';
import { EXPORT_FOLDER, extensionOf, isRaw, nextFreeName } from './core/images';
import { isDefault } from './core/xmp';
import { EditStore } from './edits';
import { Libraries } from './libraries';
import { mapLimit, PhotoStore } from './photoStore';

const RECENT_TARGETS = 'polaroica.recentExportTargets';

/** Photos that can be exported: JPEGs and RAW files. */
export function isExportable(name: string): boolean {
  const ext = extensionOf(name);
  return isRaw(name) || ext === 'jpg' || ext === 'jpeg';
}

/** Export to JPEG: pick which photos, how big and where; then render them on worker threads. */
export class PhotoExporter {
  /** Opens a folder's grid (set by the extension once the grids exist). */
  openFolder?: (folder: vscode.Uri) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly libraries: Libraries,
    private readonly store: PhotoStore,
    private readonly edits: EditStore,
    private readonly log: (line: string) => void,
  ) {}

  /** From a folder: asks which photos (selection, picks, stars…), size and destination. */
  async exportFrom(folder: vscode.Uri, selected: string[] = []): Promise<void> {
    const where = this.libraries.crumbs(folder).join(' / ');
    const [photos, culling] = await Promise.all([this.store.photos(folder), this.edits.cullingIn(folder.fsPath)]);
    const all = photos.filter((p) => isExportable(p.name)).map((p) => p.name);
    if (!all.length) {
      void vscode.window.showInformationMessage(`No JPEG or RAW photos to export in ${where}.`);
      return;
    }
    const c = (n: string) => culling.get(n);
    const choices: Array<{ label: string; names: string[]; detail?: string }> = [
      { label: '$(selection) Selected photos', names: selected.filter(isExportable) },
      { label: '$(check) Picks', names: all.filter((n) => c(n)?.flag === 'pick') },
      { label: '$(star-full) 5 stars', names: all.filter((n) => (c(n)?.rating ?? 0) >= 5) },
      { label: '$(star-full) 4 stars and up', names: all.filter((n) => (c(n)?.rating ?? 0) >= 4) },
      { label: '$(circle-slash) Everything but rejects', names: all.filter((n) => c(n)?.flag !== 'reject') },
      { label: '$(files) All photos', names: all },
    ].filter((x) => x.names.length);
    const which = await vscode.window.showQuickPick(
      choices.map((x) => ({ ...x, description: `${x.names.length} photo${x.names.length === 1 ? '' : 's'}` })),
      { title: `Export from ${where} (1/3)`, placeHolder: 'Which photos?' },
    );
    if (which) {
      await this.exportPhotos(which.names.map((n) => vscode.Uri.file(path.join(folder.fsPath, n))), folder);
    }
  }

  /** Asks size and destination for these photos, then exports them. */
  async exportPhotos(files: vscode.Uri[], folder = vscode.Uri.file(path.dirname(files[0].fsPath))): Promise<void> {
    files = files.filter((f) => isExportable(path.basename(f.fsPath)));
    if (!files.length) {
      void vscode.window.showInformationMessage('Only JPEG and RAW photos can be exported.');
      return;
    }
    const n = files.length;
    const what = n === 1 ? path.basename(files[0].fsPath) : `${n} photos`;
    const sizes = [
      { label: 'Full size', detail: 'Every pixel (RAW files are developed at full sensor resolution)', maxSide: undefined },
      { label: 'Long edge 3840 px', detail: '4K screens and most prints up to A4', maxSide: 3840 },
      { label: 'Long edge 2048 px', detail: 'Sharing: messages, social media, email', maxSide: 2048 },
    ];
    const size = await vscode.window.showQuickPick(sizes, { title: `Export ${what} (2/3)`, placeHolder: 'How big?' });
    if (!size) {
      return;
    }
    const target = await this.pickTarget(folder, what);
    if (!target) {
      return;
    }
    await this.run(files, target, size.maxSide);
  }

  private async pickTarget(folder: vscode.Uri, what: string): Promise<vscode.Uri | undefined> {
    const recents = this.context.globalState.get<string[]>(RECENT_TARGETS, []).filter((p) => fs.existsSync(p));
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri; choose?: boolean };
    const inside = vscode.Uri.file(path.join(folder.fsPath, EXPORT_FOLDER));
    const items: Item[] = [
      { label: '$(new-folder) Export folder in this album', description: inside.fsPath, uri: inside },
      ...recents
        .filter((r) => r !== inside.fsPath)
        .map((r) => ({ label: `$(history) ${path.basename(r)}`, description: r, uri: vscode.Uri.file(r) })),
      { label: '$(folder-opened) Choose a folder…', choose: true },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: `Export ${what} (3/3)`, placeHolder: 'Where to?' });
    if (!pick) {
      return undefined;
    }
    let target = pick.uri;
    if (pick.choose) {
      const picked = await vscode.window.showOpenDialog({
        title: `Export ${what} to…`,
        defaultUri: folder,
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Export Here',
      });
      target = picked?.[0];
    }
    if (target) {
      await fs.promises.mkdir(target.fsPath, { recursive: true });
      const list = this.context.globalState.get<string[]>(RECENT_TARGETS, []);
      await this.context.globalState.update(RECENT_TARGETS, [target.fsPath, ...list.filter((p) => p !== target!.fsPath)].slice(0, 5));
    }
    return target;
  }

  private async run(files: vscode.Uri[], target: vscode.Uri, maxSide: number | undefined): Promise<void> {
    const quality = Math.max(50, Math.min(100, vscode.workspace.getConfiguration('polaroica').get<number>('export.quality', 90)));
    const where = this.libraries.libraryOf(target) ? this.libraries.crumbs(target).join(' / ') : target.fsPath;
    const n = files.length;

    // Destination names: <name>.jpg; a name already there is replaced, kept or skipped (asked once).
    const existing = new Set(await fs.promises.readdir(target.fsPath).catch(() => [] as string[]));
    const planned = new Set<string>();
    let onConflict: 'ask' | 'replace' | 'keepBoth' | 'skip' = 'ask';
    const jobs: Array<{ src: vscode.Uri; dest: string }> = [];
    let skipped = 0;
    for (const src of files) {
      const base = path.basename(src.fsPath).replace(/\.[^.]+$/, '') + '.jpg';
      let name = base;
      if (planned.has(name)) {
        name = nextFreeName(base, (x) => planned.has(x) || existing.has(x)); // a RAW and a JPEG of the same shot
      } else if (existing.has(name)) {
        if (onConflict === 'ask') {
          const picked = await vscode.window.showWarningMessage(
            `${name} is already in ${where}.`,
            { modal: true, detail: 'This applies to every photo of this export that is already there.' },
            'Replace',
            'Keep Both',
            'Skip',
          );
          if (!picked) {
            return;
          }
          onConflict = picked === 'Replace' ? 'replace' : picked === 'Keep Both' ? 'keepBoth' : 'skip';
        }
        if (onConflict === 'skip') {
          skipped++;
          continue;
        }
        if (onConflict === 'keepBoth') {
          name = nextFreeName(base, (x) => planned.has(x) || existing.has(x));
        }
      }
      planned.add(name);
      jobs.push({ src, dest: path.join(target.fsPath, name) });
    }
    if (!jobs.length) {
      void vscode.window.showInformationMessage(`Nothing exported: all ${n === 1 ? 'of it is' : `${n} photos are`} already in ${where}.`);
      return;
    }

    // RAW decoding takes ~700 MB per thread: at most two at a time.
    const hasRaw = jobs.some((j) => isRaw(path.basename(j.src.fsPath)));
    const pool = new ExportPool(Math.max(1, Math.min(hasRaw ? 2 : 4, cpuCores() - 1)));
    const failed: string[] = [];
    let done = 0;
    const started = Date.now();
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting to ${where}`, cancellable: true },
      async (progress, token) => {
        token.onCancellationRequested(() => pool.dispose());
        progress.report({ message: `0 of ${jobs.length}` });
        await mapLimit(jobs, 4, async (job) => {
          if (token.isCancellationRequested) {
            return;
          }
          const name = path.basename(job.src.fsPath);
          try {
            const sc = await this.edits.loadSidecar(job.src);
            const edits = sc?.edits && !isDefault(sc.edits) ? sc.edits : undefined;
            const r = await pool.run(job.src.fsPath, job.dest, { quality, maxSide, edits });
            this.log(`Exported ${name} → ${job.dest} (${r.width}×${r.height}, ${(r.bytes / 1e6).toFixed(1)} MB, ${r.source}${edits ? ', edited' : ''})`);
          } catch (err) {
            if (token.isCancellationRequested) {
              return;
            }
            const msg = err instanceof Error ? err.message : String(err);
            failed.push(`${name}: ${msg}`);
            this.log(`Export failed: ${name}: ${msg}`);
          }
          done++;
          progress.report({ message: `${done} of ${jobs.length} · ${name}`, increment: 100 / jobs.length });
        });
      },
    );
    pool.dispose();
    // A cancelled export can leave the file it was writing half done.
    await Promise.all(jobs.map((j) => fs.promises.rm(`${j.dest}.partial`, { force: true }).catch(() => undefined)));
    this.store.invalidate(target);

    const ok = done - failed.length;
    this.log(`Export to ${target.fsPath}: ${ok} done, ${failed.length} failed, ${skipped} skipped, ${Math.round((Date.now() - started) / 1000)} s`);
    if (failed.length) {
      void vscode.window.showErrorMessage(
        `Could not export ${failed.length === 1 ? '1 photo' : `${failed.length} photos`}: ${failed.slice(0, 2).join('; ')}`,
      );
    }
    if (ok > 0) {
      const open = this.libraries.libraryOf(target) && this.openFolder ? 'Open' : undefined;
      const pick = await vscode.window.showInformationMessage(
        `Exported ${ok === 1 ? '1 photo' : `${ok} photos`} to ${where}` + (skipped ? ` (${skipped} already there, skipped)` : '') + '.',
        ...(open ? [open] : []),
        'Reveal in OS',
      );
      if (pick === 'Open') {
        this.openFolder?.(target);
      } else if (pick === 'Reveal in OS') {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(jobs[0].dest));
      }
    }
  }
}
