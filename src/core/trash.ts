import * as path from 'path';
import { SIDECAR_DIR, sidecarName } from './xmp';

export interface DeleteItem {
  name: string;
  /** The photo file. */
  photo: string;
  /** Its sidecar (ratings, flag, edits); may not exist. */
  sidecar: string;
  size: number;
}

export interface DeletePlan {
  items: DeleteItem[];
  bytes: number;
}

/**
 * The rejected photos of a folder that are still on disk, with their sidecars. A sidecar that
 * says "reject" for a photo no longer in the listing is left alone.
 */
export function planRejectDelete(
  folder: string,
  photos: ReadonlyArray<{ name: string; size: number }>,
  culling: ReadonlyMap<string, { flag?: string }>,
): DeletePlan {
  const items: DeleteItem[] = photos
    .filter((p) => culling.get(p.name)?.flag === 'reject')
    .map((p) => ({
      name: p.name,
      photo: path.join(folder, p.name),
      sidecar: path.join(folder, SIDECAR_DIR, sidecarName(p.name)),
      size: p.size,
    }));
  return { items, bytes: items.reduce((a, i) => a + i.size, 0) };
}

/** An explicit set of photos (right-click → Delete), with their sidecars. */
export function planPhotoDelete(files: ReadonlyArray<{ path: string; size: number }>): DeletePlan {
  const items: DeleteItem[] = files.map((f) => ({
    name: path.basename(f.path),
    photo: f.path,
    sidecar: path.join(path.dirname(f.path), SIDECAR_DIR, sidecarName(path.basename(f.path))),
    size: f.size,
  }));
  return { items, bytes: items.reduce((a, i) => a + i.size, 0) };
}

/**
 * The rejects among a set of photos that may span folders, which is what a tag album is. Each
 * folder's own sidecars say what is rejected there; a reject in one of those folders that is not
 * in the set is not part of the album, and is left alone.
 */
export function planRejectDeleteAmong(
  photos: ReadonlyArray<{ path: string; size: number }>,
  cullingOf: (folder: string) => ReadonlyMap<string, { flag?: string }>,
): DeletePlan {
  const byFolder = new Map<string, Array<{ name: string; size: number }>>();
  for (const p of photos) {
    const folder = path.dirname(p.path);
    const here = byFolder.get(folder);
    const entry = { name: path.basename(p.path), size: p.size };
    if (here) {
      here.push(entry);
    } else {
      byFolder.set(folder, [entry]);
    }
  }
  return mergePlans([...byFolder].map(([folder, names]) => planRejectDelete(folder, names, cullingOf(folder))));
}

/** One plan out of several folders' plans: a tag album's rejects live wherever their photos do. */
export function mergePlans(plans: ReadonlyArray<DeletePlan>): DeletePlan {
  const items = plans.flatMap((p) => p.items);
  return { items, bytes: items.reduce((a, i) => a + i.size, 0) };
}

export interface DeleteOutcome {
  trashed: number;
  removed: number;
  failed: string[];
}

export interface DeleteRunner {
  /** Deletes one item; rejects with whatever the file system said. */
  delete(item: DeleteItem, useTrash: boolean): Promise<void>;
  /** True when the error only means the file was already gone. */
  isGone(err: unknown): boolean;
  /**
   * Asked once, the first time the Trash refuses a photo: delete the rest permanently? Everything
   * waits on the answer, and a "no" stops the run.
   */
  askPermanent(item: DeleteItem, message: string, left: number): Promise<boolean>;
  /** Called as each item finishes, successfully or not. */
  progress(done: number, item: DeleteItem): void;
  cancelled(): boolean;
  /** How many deletes to have in flight. */
  concurrency?: number;
}

/**
 * Deletes a plan's items with several in flight at once, which is what makes a cull of a few
 * hundred photos finish in seconds: a single trash call is mostly waiting on the OS.
 */
export async function runDeletes(
  items: ReadonlyArray<DeleteItem>,
  runner: DeleteRunner,
): Promise<DeleteOutcome> {
  const out: DeleteOutcome = { trashed: 0, removed: 0, failed: [] };
  let useTrash = true;
  let stopped = false;
  let asking: Promise<boolean> | undefined;
  let next = 0;
  let done = 0;
  const retry: DeleteItem[] = [];

  // Asked once for the whole run: the volume either has a Trash or it doesn't.
  const askOnce = (item: DeleteItem, message: string): Promise<boolean> => {
    asking ??= runner.askPermanent(item, message, items.length - done).then((ok) => {
      if (ok) {
        useTrash = false;
      } else {
        stopped = true;
      }
      return ok;
    });
    return asking;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (asking && !(await asking)) {
        return;
      }
      if (stopped || runner.cancelled()) {
        return;
      }
      const item = retry.shift() ?? (next < items.length ? items[next++] : undefined);
      if (!item) {
        return;
      }
      // Read once: by the time a failure is handled, another lane may already have the answer.
      const tried = useTrash;
      try {
        await runner.delete(item, tried);
        if (tried) {
          out.trashed++;
        } else {
          out.removed++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (tried && !runner.isGone(err)) {
          // Network shares usually have no Trash: offer to delete the rest for good, and try
          // this photo again once we know.
          retry.push(item);
          if (!(await askOnce(item, message))) {
            return;
          }
          continue;
        }
        out.failed.push(`${item.name}: ${message}`);
      }
      runner.progress(++done, item);
    }
  };

  const lanes = Math.max(1, Math.min(runner.concurrency ?? 8, items.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  return out;
}
