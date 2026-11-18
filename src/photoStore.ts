import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { compareNames, isHiddenFolder, isPhoto, PhotoEntry, sortPhotos, SortKey } from './core/images';
import { ExifInfo, readExif } from './core/exif';

export interface Photo extends PhotoEntry {
  uri: vscode.Uri;
}

export interface FolderListing {
  folders: string[];
  photos: Photo[];
}

/** Runs `fn` over `items` with at most `limit` in flight (network shares dislike floods). */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Reads folders from disk (libraries are local paths or OS-mounted SMB shares) and caches the
 * listings until something changes them.
 */
export class PhotoStore implements vscode.Disposable {
  private readonly listings = new Map<string, Promise<FolderListing>>();
  private readonly exifCache = new Map<string, Promise<ExifInfo | undefined>>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri | undefined>();
  /** Fires with a folder whose contents changed, or `undefined` for "everything". */
  readonly onDidChange = this.changed.event;

  listing(folder: vscode.Uri): Promise<FolderListing> {
    const key = folder.fsPath;
    let p = this.listings.get(key);
    if (!p) {
      p = this.read(folder);
      this.listings.set(key, p);
      p.catch(() => this.listings.delete(key));
    }
    return p;
  }

  async photos(folder: vscode.Uri, sort: SortKey = 'name'): Promise<Photo[]> {
    return sortPhotos((await this.listing(folder)).photos, sort);
  }

  exif(file: vscode.Uri): Promise<ExifInfo | undefined> {
    const key = file.fsPath;
    let p = this.exifCache.get(key);
    if (!p) {
      p = readHead(file.fsPath, 256 * 1024).then(readExif, () => undefined);
      this.exifCache.set(key, p);
    }
    return p;
  }

  invalidate(folder?: vscode.Uri): void {
    if (folder) {
      this.listings.delete(folder.fsPath);
    } else {
      this.listings.clear();
      this.exifCache.clear();
    }
    this.changed.fire(folder);
  }

  forgetFile(file: vscode.Uri): void {
    this.exifCache.delete(file.fsPath);
  }

  private async read(folder: vscode.Uri): Promise<FolderListing> {
    const entries = await fs.promises.readdir(folder.fsPath, { withFileTypes: true });
    const folders: string[] = [];
    const photoNames: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!isHiddenFolder(e.name)) {
          folders.push(e.name);
        }
      } else if ((e.isFile() || e.isSymbolicLink()) && isPhoto(e.name)) {
        photoNames.push(e.name);
      }
    }
    folders.sort(compareNames);
    const photos = (
      await mapLimit(photoNames, 16, async (name): Promise<Photo | undefined> => {
        const full = path.join(folder.fsPath, name);
        try {
          const st = await fs.promises.stat(full);
          return st.isFile() ? { name, size: st.size, mtime: st.mtimeMs, uri: vscode.Uri.file(full) } : undefined;
        } catch {
          return undefined;
        }
      })
    ).filter((p): p is Photo => p !== undefined);
    return { folders, photos };
  }

  dispose(): void {
    this.changed.dispose();
  }
}

export async function readHead(fsPath: string, bytes: number): Promise<Uint8Array> {
  const handle = await fs.promises.open(fsPath, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export async function isReachable(fsPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(fsPath)).isDirectory();
  } catch {
    return false;
  }
}

export function sortSetting(): SortKey {
  const v = vscode.workspace.getConfiguration('vsphoto').get<string>('sortBy', 'name');
  return v === 'modified' || v === 'size' ? v : 'name';
}
