import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function nonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

/** HTML shell for our webviews: strict CSP, our own CSS and script only. */
export function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  opts: { title: string; script: string; style: string; body: string },
): string {
  const n = nonce();
  const media = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<link rel="stylesheet" href="${media('common.css')}">
<link rel="stylesheet" href="${media(opts.style)}">
</head>
<body>
${opts.body}
<script nonce="${n}" src="${media('common.js')}"></script>
<script nonce="${n}" src="${media(opts.script)}"></script>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Webview roots: the extension's media plus every library, so photos can be shown. */
export function localRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media'), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
}
