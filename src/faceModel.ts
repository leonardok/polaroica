import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * MediaPipe models (Apache-2.0): a face detector (BlazeFace full range, 1.1 MB) finds every face,
 * then Face Landmarker (3.7 MB) reads each one cropped on its own. Landmarker alone, with several
 * people in one frame, misses faces, reports some twice and mixes up their expressions.
 */
const MODELS = {
  landmarker: {
    file: 'face_landmarker.task',
    url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
    min: 1_000_000,
  },
  detector: {
    file: 'blaze_face_full_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_full_range/float16/1/blaze_face_full_range.tflite',
    min: 500_000,
  },
};

export interface FaceModels {
  landmarker: string;
  detector: string;
}
const CONSENT_KEY = 'vsphoto.faceModelConsent';

export function modelsDir(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, 'models');
}

function modelFiles(context: vscode.ExtensionContext): FaceModels {
  const dir = modelsDir(context).fsPath;
  return { landmarker: path.join(dir, MODELS.landmarker.file), detector: path.join(dir, MODELS.detector.file) };
}

async function have(file: string, min: number): Promise<boolean> {
  const st = await fs.promises.stat(file).catch(() => undefined);
  return !!st && st.size >= min;
}

/**
 * The face model, downloaded once (after asking) into the extension's storage. Runs entirely on
 * this computer: photos are never sent anywhere. Undefined when the person declines or the
 * download fails.
 */
export async function ensureFaceModel(context: vscode.ExtensionContext): Promise<FaceModels | undefined> {
  const files = modelFiles(context);
  const need: Array<keyof typeof MODELS> = [];
  for (const k of Object.keys(MODELS) as Array<keyof typeof MODELS>) {
    if (!(await have(files[k], MODELS[k].min))) need.push(k);
  }
  if (!need.length) {
    return files;
  }
  const mb = need.reduce((a, k) => a + (k === 'landmarker' ? 3.7 : 1.1), 0).toFixed(1);
  if (!context.globalState.get<boolean>(CONSENT_KEY)) {
    const ok = `Download (${mb} MB)`;
    const pick = await vscode.window.showInformationMessage(
      'Auto-Rank needs a face model to judge eyes, gaze and expressions.',
      {
        modal: true,
        detail:
          'MediaPipe face models (Google, Apache-2.0) are downloaded once from storage.googleapis.com. ' +
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
      { location: vscode.ProgressLocation.Notification, title: `Downloading the face models (${mb} MB)…` },
      async () => {
        for (const k of need) await download(MODELS[k].url, files[k]);
      },
    );
    return files;
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
