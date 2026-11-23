/**
 * "Find Documents and Screenshots": walks a library (or one folder) and tags what it recognises.
 *
 * Metadata only — no image is decoded — so this is I/O bound and gets through thousands of photos
 * in seconds. The verdicts come from `core/classify`; this file is the walk, the progress and the
 * writing.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  Candidate,
  classifyByMetadata,
  CONFIDENT,
  hasNoCameraSigns,
  jpegSizeFrom,
  pngSizeFrom,
  TAG_DOCUMENT,
  TAG_SCREENSHOT,
} from './core/classify';
import { EditStore } from './edits';
import { isReachable, mapLimit, Photo, PhotoStore, readHead } from './photoStore';
import { TagIndex } from './tagIndex';

/** The tags a scan owns: it may add and withdraw these, and nothing else. */
export const SCAN_TAGS = [TAG_SCREENSHOT, TAG_DOCUMENT];

export interface ScanResult {
  photos: number;
  tagged: number;
  byTag: Map<string, number>;
  cancelled: boolean;
}

export class TagScanner {
  constructor(
    private readonly store: PhotoStore,
    private readonly edits: EditStore,
    private readonly index: TagIndex,
  ) {}

  /** Scans a folder, and its sub-folders when `recursive`. Shows progress and can be cancelled. */
  async scan(root: vscode.Uri, recursive = true): Promise<ScanResult> {
    const result: ScanResult = { photos: 0, tagged: 0, byTag: new Map(), cancelled: false };
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Looking for documents in ${path.basename(root.fsPath) || root.fsPath}`,
        cancellable: true,
      },
      async (progress, token) => {
        if (!(await isReachable(root.fsPath))) {
          void vscode.window.showWarningMessage(`Can't reach ${root.fsPath}.`);
          return;
        }
        // Breadth-first, the same walk the background thumbnail builder uses: the local folder
        // index makes repeat walks cheap.
        const queue: vscode.Uri[] = [root];
        while (queue.length && !token.isCancellationRequested) {
          const folder = queue.shift()!;
          let listing;
          try {
            listing = await this.store.listing(folder);
          } catch {
            continue; // unreadable folder: skip
          }
          if (recursive) {
            for (const f of listing.folders) {
              queue.push(vscode.Uri.file(path.join(folder.fsPath, f)));
            }
          }
          await this.scanFolder(listing.photos, result, token);
          progress.report({
            message: `${result.photos.toLocaleString()} photos · ${result.tagged.toLocaleString()} tagged`,
          });
        }
        result.cancelled = token.isCancellationRequested;
      },
    );
    await this.index.flush();
    return result;
  }

  /** Classifies one folder's photos and writes the verdicts. */
  private async scanFolder(photos: Photo[], result: ScanResult, token: vscode.CancellationToken): Promise<void> {
    const verdicts = await mapLimit(photos, 8, async (p) => {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const exif = await this.store.exif(p.uri, p.size, p.mtime).catch(() => undefined);
      const c: Candidate = { name: p.name, exif };
      // Only files with no camera data reach the rule that looks at dimensions, and only they
      // need the true size out of the header — EXIF can be stale after an edit. Ordinary camera
      // photos, which are almost all of a library, cost no extra read here.
      if (hasNoCameraSigns(exif)) {
        const d = await headerSize(p.uri.fsPath);
        c.width = d?.width;
        c.height = d?.height;
      }
      const v = classifyByMetadata(c);
      return { photo: p, tags: v.confidence >= CONFIDENT ? v.tags : [] };
    });

    for (const v of verdicts) {
      if (!v) {
        continue;
      }
      result.photos++;
    }
    // Write only where a scan tag needs to be added or withdrawn, so a second run over an
    // already-scanned library touches no files.
    const changes = verdicts.filter((v): v is { photo: Photo; tags: string[] } => !!v);
    const toWrite: { photo: Photo; add: string[] }[] = [];
    for (const { photo, tags } of changes) {
      const have = (await this.edits.tagsOf(photo.uri)).filter((t) => SCAN_TAGS.some((s) => s.toLowerCase() === t.toLowerCase()));
      const want = tags;
      const sameAlready = have.length === want.length && want.every((w) => have.some((h) => h.toLowerCase() === w.toLowerCase()));
      if (!sameAlready) {
        toWrite.push({ photo, add: want });
      }
      if (want.length) {
        result.tagged++;
        for (const t of want) {
          result.byTag.set(t, (result.byTag.get(t) ?? 0) + 1);
        }
      }
    }
    await mapLimit(toWrite, 6, async ({ photo, add }) => {
      // `replaceAuto` lets the scan withdraw a guess it no longer stands behind; a tag added by
      // hand is never touched (see EditStore.tag).
      const now = await this.edits.tag([photo.uri], { add, auto: true, replaceAuto: true });
      await this.index.set(photo.uri.fsPath, photo.size, photo.mtime, now.get(photo.uri.fsPath) ?? []);
    });
  }
}

/**
 * The size the image really is, from its own header — PNG's IHDR or JPEG's SOF — rather than from
 * EXIF, which an editor may leave behind at the size the photo used to be.
 */
async function headerSize(fsPath: string): Promise<{ width: number; height: number } | undefined> {
  // Enough for IHDR, and to reach the SOF past a large EXIF or colour profile segment.
  const head = await readHead(fsPath, 128 * 1024).catch(() => undefined);
  if (!head) {
    return undefined;
  }
  return pngSizeFrom(head) ?? jpegSizeFrom(head);
}

/** "3 screenshots" / "2 screenshots and 1 document", for the message at the end. */
export function describeResult(r: ScanResult): string {
  const parts = [...r.byTag].map(([tag, n]) => `${n.toLocaleString()} ${tag.toLowerCase()}${n === 1 ? '' : 's'}`);
  if (!parts.length) {
    return `Looked at ${r.photos.toLocaleString()} photos and found nothing to tag.`;
  }
  const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
  return `Tagged ${list} in ${r.photos.toLocaleString()} photos${r.cancelled ? ' (stopped early)' : ''}.`;
}

/**
 * Adds or removes tags by hand and keeps the index in step. Used by the grid's right-click menu;
 * the scan writes its own, because it already knows each photo's size and time.
 */
export async function applyTags(
  edits: EditStore,
  index: TagIndex,
  photos: vscode.Uri[],
  change: { add?: string[]; remove?: string[] },
): Promise<void> {
  const now = await edits.tag(photos, change);
  await mapLimit(photos, 6, async (uri) => {
    const st = await fs.promises.stat(uri.fsPath).catch(() => undefined);
    if (!st) {
      await index.forget(uri.fsPath);
      return;
    }
    await index.set(uri.fsPath, st.size, Math.round(st.mtimeMs), now.get(uri.fsPath) ?? []);
  });
  await index.flush();
}
