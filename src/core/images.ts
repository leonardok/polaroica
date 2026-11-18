/** File-type knowledge shared by the tree, the grid and the viewer. No `vscode` import: unit-testable. */

/** Formats the webview (Chromium) can draw directly. */
export const DISPLAYABLE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg',
]);

/** Camera RAW and other photo formats we list but cannot draw in a webview (yet). */
export const RAW_EXTENSIONS = new Set([
  'nef', 'nrw', 'cr2', 'cr3', 'crw', 'arw', 'srf', 'sr2', 'dng', 'raf', 'orf', 'rw2', 'pef',
  'srw', 'x3f', 'erf', 'kdc', 'mrw', '3fr', 'iiq', 'rwl',
]);

export const OTHER_PHOTO_EXTENSIONS = new Set(['tif', 'tiff', 'heic', 'heif']);

/** TIFF-structured formats whose EXIF we can read with the TIFF parser. */
export const TIFF_BASED_EXTENSIONS = new Set([
  'tif', 'tiff', 'nef', 'nrw', 'cr2', 'arw', 'srf', 'sr2', 'dng', 'orf', 'rw2', 'pef', 'srw',
  'erf', 'kdc', '3fr', 'iiq', 'rwl',
]);

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

export function isPhoto(name: string): boolean {
  if (name.startsWith('.')) {
    return false; // macOS "._" resource forks, hidden files
  }
  const ext = extensionOf(name);
  return DISPLAYABLE_EXTENSIONS.has(ext) || RAW_EXTENSIONS.has(ext) || OTHER_PHOTO_EXTENSIONS.has(ext);
}

export function isDisplayable(name: string): boolean {
  return DISPLAYABLE_EXTENSIONS.has(extensionOf(name));
}

export function isRaw(name: string): boolean {
  return RAW_EXTENSIONS.has(extensionOf(name));
}

/** Folders the tree should not show. */
export function isHiddenFolder(name: string): boolean {
  return (
    name.startsWith('.') ||
    name.startsWith('@') || // Synology @eaDir, @Recycle
    name === '#recycle' ||
    name === '$RECYCLE.BIN' ||
    name === 'System Volume Information' ||
    name === 'node_modules'
  );
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Natural sort: "IMG_2" before "IMG_10". */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export type SortKey = 'name' | 'modified' | 'size';

export interface PhotoEntry {
  name: string;
  size: number;
  mtime: number;
}

export function sortPhotos<T extends PhotoEntry>(photos: T[], key: SortKey, descending = false): T[] {
  const sorted = [...photos].sort((a, b) => {
    let d = 0;
    if (key === 'modified') {
      d = a.mtime - b.mtime;
    } else if (key === 'size') {
      d = a.size - b.size;
    }
    return d !== 0 ? d : compareNames(a.name, b.name);
  });
  return descending ? sorted.reverse() : sorted;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "photo.jpg" -> "photo (1).jpg", "photo (1).jpg" -> "photo (2).jpg". */
export function nextFreeName(name: string, taken: (candidate: string) => boolean): string {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  const base = stem.replace(/ \(\d+\)$/, '');
  for (let n = 1; n < 10000; n++) {
    const candidate = `${base} (${n})${ext ? '.' + name.slice(-(ext.length)) : ''}`;
    if (!taken(candidate)) {
      return candidate;
    }
  }
  throw new Error(`No free name for ${name}`);
}
