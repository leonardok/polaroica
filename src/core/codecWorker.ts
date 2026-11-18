/** Worker thread: decodes JPEGs off the extension host's main thread (thumbnails, Auto-Rank). */
import { parentPort } from 'worker_threads';
import { AnalyzeOptions, analyzeHere, makeThumbHere, ThumbOptions } from './codec';

parentPort?.on('message', async (m: { id: number; kind?: 'thumb' | 'analyze'; jpeg: Uint8Array; opts: ThumbOptions & AnalyzeOptions }) => {
  try {
    if (m.kind === 'analyze') {
      const analysis = await analyzeHere(m.jpeg, m.opts);
      const px = analysis.pixels?.data;
      parentPort!.postMessage({ id: m.id, ok: true, analysis }, px ? [px.buffer as ArrayBuffer] : []);
      return;
    }
    const t = await makeThumbHere(m.jpeg, m.opts);
    const data = new Uint8Array(t.data);
    parentPort!.postMessage({ id: m.id, ok: true, thumb: { ...t, data } }, [data.buffer]);
  } catch (err) {
    parentPort!.postMessage({ id: m.id, ok: false, error: String(err instanceof Error ? err.message : err) });
  }
});
