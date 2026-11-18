import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';

/** MediaPipe Face Landmarker (Apache-2.0), float16, ~3.7 MB. */
export const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const CONSENT_KEY = 'vsphoto.faceModelConsent';

export function modelsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'models');
}

export function faceModelFile(context: vscode.ExtensionContext): string {
  return path.join(modelsDir(context).fsPath, 'face_landmarker.task');
}

/**
 * The face model, downloaded once (after asking) into the extension's storage. Runs entirely on
 * this computer: photos are never sent anywhere. Undefined when the person declines or the
 * download fails.
 */
export async function ensureFaceModel(context: vscode.ExtensionContext): Promise<string | undefined> {
  const file = faceModelFile(context);
  const st = await fs.promises.stat(file).catch(() => undefined);
  if (st && st.size > 1_000_000) {
    return file;
  }
  if (!context.globalState.get<boolean>(CONSENT_KEY)) {
    const ok = 'Download (3.7 MB)';
    const pick = await vscode.window.showInformationMessage(
      'Auto-Rank needs a face model to judge eyes, gaze and expressions.',
      {
        modal: true,
        detail:
          'MediaPipe Face Landmarker (Google, Apache-2.0) is downloaded once from storage.googleapis.com. ' +
          'It runs on this computer; your photos are never uploaded.',
      },
      ok,
    );
    if (pick !== ok) {
      return undefined;
    }
    await context.globalState.update(CONSENT_KEY, true);
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Downloading the face model (3.7 MB)…' },
      () => download(FACE_MODEL_URL, file),
    );
    return file;
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not download the face model: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

async function download(url: string, dest: string, redirects = 5): Promise<void> {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  await new Promise<void>((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
          res.resume();
          download(new URL(res.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(tmp);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
        res.on('error', reject);
      })
      .on('error', reject);
  });
  if (fs.existsSync(tmp)) {
    const size = (await fs.promises.stat(tmp)).size;
    if (size < 1_000_000) {
      await fs.promises.rm(tmp, { force: true });
      throw new Error('the download was incomplete');
    }
    await fs.promises.rename(tmp, dest);
  }
}
