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
