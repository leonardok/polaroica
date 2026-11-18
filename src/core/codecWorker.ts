/** Worker thread: decodes JPEGs and encodes WebP thumbnails off the extension host's main thread. */
import { parentPort } from 'worker_threads';
import { makeThumbHere, ThumbOptions } from './codec';

parentPort?.on('message', async (m: { id: number; jpeg: Uint8Array; opts: ThumbOptions }) => {
  try {
    const t = await makeThumbHere(m.jpeg, m.opts);
    const data = new Uint8Array(t.data);
    parentPort!.postMessage({ id: m.id, ok: true, thumb: { ...t, data } }, [data.buffer]);
  } catch (err) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});
