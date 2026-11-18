/** What an album holds, for the sidebar's hover: counts by type and by culling state. No `vscode` import. */
import { extensionOf, isRaw } from './images';

export interface AlbumStats {
  photos: number;
  raw: number;
  jpeg: number;
  /** PNG, HEIC, TIFF and the like. */
  other: number;
  picks: number;
  rejects: number;
  /** Neither picked nor rejected: still to look at. */
  toCull: number;
  /** With at least one star. */
  rated: number;
  edited: number;
  /** Rated by Auto-Rank (and not changed since). */
  autoRanked: number;
}

/** Counts for the photos in `names`; culling entries of photos no longer there are ignored. */
export function albumStats(
  names: readonly string[],
  culling: ReadonlyMap<string, { rating: number; flag?: string; edited: boolean; auto?: unknown }>,
): AlbumStats {
  const s: AlbumStats = { photos: names.length, raw: 0, jpeg: 0, other: 0, picks: 0, rejects: 0, toCull: 0, rated: 0, edited: 0, autoRanked: 0 };
  for (const n of names) {
    const ext = extensionOf(n);
    if (isRaw(n)) s.raw++;
    else if (ext === 'jpg' || ext === 'jpeg') s.jpeg++;
    else s.other++;
    const c = culling.get(n);
    if (c?.flag === 'pick') s.picks++;
    else if (c?.flag === 'reject') s.rejects++;
    else s.toCull++;
    if (c && c.rating > 0) s.rated++;
    if (c?.edited) s.edited++;
    if (c?.auto) s.autoRanked++;
  }
  return s;
}
