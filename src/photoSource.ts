/**
 * Where a grid's photos come from. A grid used to be a folder; now it is a source, so the same
 * layout can show one folder's photos or every photo carrying a tag, wherever it lives.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SortKey, sortPhotos } from './core/images';
import { Libraries } from './libraries';
import { Photo, PhotoStore } from './photoStore';
import { TagIndex } from './tagIndex';

/**
 * One photo in a grid. `key` identifies it inside its grid — the file name in a folder album, a
 * relative path in a tag album, where two folders may hold the same name. The webview treats it as
 * an opaque string. `label` is the caption, `sub` the quieter second line under it.
 */
export interface GridPhoto {
  key: string;
  label: string;
  sub?: string;
  photo: Photo;
}

export interface PhotoSource {
  /** Identifies the grid tab: one tab per source. */
  readonly id: string;
  /** Tab title. */
  readonly title: string;
  readonly kind: 'folder' | 'tag';
  /**
   * The folder this grid *is*, when it is one. Album-wide actions — Auto-Rank, Delete Rejected,
   * the face model — need a real folder and are hidden without it.
   */
  readonly folder?: vscode.Uri;
  crumbs(): string[];
  photos(sort: SortKey): Promise<GridPhoto[]>;
}

/** One folder's photos: what a grid has always shown. */
export class FolderSource implements PhotoSource {
  readonly kind = 'folder';

  constructor(
    readonly folder: vscode.Uri,
    private readonly store: PhotoStore,
    private readonly libraries: Libraries,
  ) {}

  /** The id a folder's grid has, without building the source (see GridPanels.detectFaces). */
  static idFor(folder: vscode.Uri): string {
    return 'folder:' + folder.fsPath;
  }

  get id(): string {
    return FolderSource.idFor(this.folder);
  }

  get title(): string {
    return path.basename(this.folder.fsPath) || this.folder.fsPath;
  }

  crumbs(): string[] {
    return this.libraries.crumbs(this.folder);
  }

  async photos(sort: SortKey): Promise<GridPhoto[]> {
    const photos = await this.store.photos(this.folder, sort);
    return photos.map((photo) => ({ key: photo.name, label: photo.name, photo }));
  }
}

/** Every photo carrying one tag, from every library. */
export class TagSource implements PhotoSource {
  readonly kind = 'tag';
  readonly folder = undefined;

  constructor(
    readonly tag: string,
    private readonly index: TagIndex,
    private readonly libraries: Libraries,
  ) {}

  get id(): string {
    return 'tag:' + this.tag.toLowerCase();
  }

  get title(): string {
    return this.tag;
  }

  crumbs(): string[] {
    return ['Tags', this.tag];
  }

  async photos(sort: SortKey): Promise<GridPhoto[]> {
    const tagged = await this.index.photosWithTag(this.tag);
    const photos: Photo[] = tagged.map((t) => ({
      name: path.basename(t.fsPath),
      size: t.size,
      mtime: t.mtime,
      uri: vscode.Uri.file(t.fsPath),
    }));
    return sortPhotos(photos, sort).map((photo) => {
      const dir = path.dirname(photo.uri.fsPath);
      const lib = this.libraries.libraryOf(photo.uri);
      // Relative to the library, so the key is short but still unique across libraries.
      const rel = lib ? path.relative(lib.uri.fsPath, photo.uri.fsPath) : photo.uri.fsPath;
      const where = lib ? [lib.name, ...path.relative(lib.uri.fsPath, dir).split(/[\\/]/).filter(Boolean)].join(' · ') : dir;
      return { key: lib ? `${lib.name}/${rel}` : rel, label: photo.name, sub: where, photo };
    });
  }
}

/** Drops photos whose file has gone (a tag album is built from a remembered list). */
export async function stillThere(photos: GridPhoto[]): Promise<GridPhoto[]> {
  const ok = await Promise.all(photos.map((p) => fs.promises.stat(p.photo.uri.fsPath).then(() => true, () => false)));
  return photos.filter((_, i) => ok[i]);
}
