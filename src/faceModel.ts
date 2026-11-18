import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * MediaPipe face models (Google, Apache-2.0; see models/README.md), shipped with the extension:
 * a face detector (BlazeFace full range, 1.1 MB) finds every face, then Face Landmarker (3.7 MB)
 * reads each one cropped on its own. Landmarker alone, with several people in one frame, misses
 * faces, reports some twice and mixes up their expressions. They run on this computer, in the
 * grid tab; photos are never uploaded.
 */
export interface FaceModels {
  landmarker: string;
  detector: string;
}

export function faceModels(context: vscode.ExtensionContext): FaceModels | undefined {
  const file = (name: string) => vscode.Uri.joinPath(context.extensionUri, 'models', name).fsPath;
  const m = { landmarker: file('face_landmarker.task'), detector: file('blaze_face_full_range.tflite') };
  return fs.existsSync(m.landmarker) && fs.existsSync(m.detector) ? m : undefined;
}
