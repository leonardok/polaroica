import * as path from 'path';
import * as vscode from 'vscode';
import { cameraLabel, formatExifDate, formatExposure } from './core/exif';
import { extensionOf, formatBytes, isDisplayable, isRaw } from './core/images';
import { Photo, PhotoStore } from './photoStore';

/** What the webviews show for one photo. */
export interface PhotoView {
  name: string;
  path: string;
  /** file:// URI, used for drag and drop. */
  fileUri: string;
  src?: string; // webview URI, when the format can be drawn
  ext: string;
  raw: boolean;
  size: number;
  mtime: number;
}

export function toView(webview: vscode.Webview, p: Photo): PhotoView {
  return {
    name: p.name,
    path: p.uri.fsPath,
    fileUri: p.uri.toString(),
    src: isDisplayable(p.name) ? webview.asWebviewUri(p.uri).toString() : undefined,
    ext: extensionOf(p.name).toUpperCase(),
    raw: isRaw(p.name),
    size: p.size,
    mtime: p.mtime,
  };
}

export interface DetailRow {
  label: string;
  value: string;
}

/** Rows for the details panel; EXIF rows when the file has them. */
export async function detailRows(store: PhotoStore, p: Photo): Promise<DetailRow[]> {
  const rows: DetailRow[] = [];
  const exif = await store.exif(p.uri);
  if (exif?.dateTaken) {
    rows.push({ label: 'Taken', value: formatExifDate(exif.dateTaken) });
  }
  const camera = exif && cameraLabel(exif);
  if (camera) {
    rows.push({ label: 'Camera', value: camera });
  }
  if (exif?.lens) {
    rows.push({ label: 'Lens', value: exif.lens });
  }
  const exposure = [
    exif?.exposureTime ? formatExposure(exif.exposureTime) : undefined,
    exif?.fNumber ? `f/${Number(exif.fNumber.toFixed(1))}` : undefined,
    exif?.iso ? `ISO ${exif.iso}` : undefined,
    exif?.focalLength ? `${Math.round(exif.focalLength)} mm` : undefined,
  ].filter(Boolean);
  if (exposure.length) {
    rows.push({ label: 'Exposure', value: exposure.join(' · ') });
  }
  if (exif?.width && exif.height) {
    rows.push({ label: 'Dimensions', value: `${exif.width} × ${exif.height}` });
  }
  rows.push({ label: 'File size', value: formatBytes(p.size) });
  rows.push({ label: 'Modified', value: new Date(p.mtime).toLocaleString() });
  rows.push({ label: 'Location', value: path.dirname(p.uri.fsPath) });
  return rows;
}
