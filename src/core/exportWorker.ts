/** Worker thread: exports photos to JPEG off the extension host's main thread. */
import { parentPort } from 'worker_threads';
import { exportHere, ExportOptions } from './exporter';

parentPort?.on('message', async (m: { id: number; src: string; dest: string; opts: ExportOptions }) => {
  try {
    const result = await exportHere(m.src, m.dest, m.opts);
    parentPort!.postMessage({ id: m.id, ok: true, result });
  } catch (err) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});
