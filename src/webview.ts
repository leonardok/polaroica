import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { toWire } from './core/wire';

export { fromWire } from './core/wire';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

const assetCache = new Map<string, string>();

/** Reads a file from media/ once. Inlined so a webview paints without fetching anything. */
function asset(extensionUri: vscode.Uri, file: string): string {
  const p = vscode.Uri.joinPath(extensionUri, 'media', file).fsPath;
  let text = assetCache.get(p);
  if (text === undefined) {
    text = fs.readFileSync(p, 'utf8');
    assetCache.set(p, text);
  }
  return text;
}

/**
 * HTML for our webviews: strict CSP; CSS and scripts inlined. Inlining matters: webview
 * resources share one loader, and photos streaming from a slow share must not hold up the UI.
 */
/** globalState key: the side panel's width in the grid and photo tabs (px; unset = default). */
export const DETAILS_WIDTH = 'vsphoto.detailsWidth';

export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { title: string; script: string | string[]; style: string; body: string; faces?: boolean },
): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src 'nonce-${n}'`,
    // The face model (MediaPipe, WebAssembly) loads its own scripts and files from the extension.
    opts.faces ? `script-src 'nonce-${n}' ${webview.cspSource} 'wasm-unsafe-eval'` : `script-src 'nonce-${n}'`,
    // Workers (blob:) read faces in parallel; they load the same library from the extension.
    ...(opts.faces ? [`connect-src ${webview.cspSource}`, 'worker-src blob:'] : []),
  ].join('; ');
  // A literal "</" inside inlined code would end the tag early.
  const safe = (s: string) => s.replace(/<\/(script|style)/gi, '<\\/$1');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style nonce="${n}">${safe(asset(extensionUri, 'common.css'))}
${safe(asset(extensionUri, opts.style))}</style>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
${opts.body}
<script nonce="${n}">${safe(asset(extensionUri, 'common.js'))}</script>
${(Array.isArray(opts.script) ? opts.script : [opts.script]).map((f) => `<script nonce="${n}">${safe(asset(extensionUri, f))}</script>`).join('\n')}
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Webview roots: the extension's media plus every library, so photos can be shown. */
export function localRoots(extensionUri: vscode.Uri, extra: vscode.Uri[] = []): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, 'media'),
    vscode.Uri.joinPath(extensionUri, 'node_modules', '@mediapipe', 'tasks-vision'),
    ...extra,
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
  ];
}

/** postMessage with binary data made safe for the webview (see toWire). */
export function post(webview: vscode.Webview, message: unknown): Thenable<boolean> {
  return webview.postMessage(toWire(message));
}

