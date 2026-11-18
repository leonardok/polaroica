import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePixels, hamming } from '../core/analyze';
import { groupSimilar, rankAlbum, RankInput } from '../core/rank';

/** A 200×150 test image: a pattern, optionally blurred and with a blown-out area. */
function image(opts: { seed: number; blur?: number; blownRows?: number }) {
  const w = 200;
  const h = 150;
  let data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // Large-scale light (what tells scenes apart) plus fine checker detail (what focus measures).
      const light = opts.seed === 0 ? (x / w) * 140 : (1 - y / h) * 140;
      const detail = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) * 60;
      const v = 30 + light + detail;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  for (let r = 0; r < (opts.blur ?? 0); r++) {
    const next = new Uint8ClampedArray(data);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        for (let c = 0; c < 3; c++) {
          const i = (y * w + x) * 4 + c;
          next[i] = (data[i - 4] + data[i + 4] + data[i - w * 4] + data[i + w * 4] + data[i] * 4) / 8;
        }
      }
    }
    data = next;
  }
  for (let y = 0; y < (opts.blownRows ?? 0); y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  }
  return { data, width: w, height: h };
}

test('analysis: blur lowers sharpness, white areas count as blown, hashes match similar shots', () => {
  const sharp = analyzePixels(image({ seed: 0 }));
  const soft = analyzePixels(image({ seed: 0, blur: 6 }));
  const blown = analyzePixels(image({ seed: 0, blownRows: 60 }));
  const other = analyzePixels(image({ seed: 1 }));
  assert.ok(sharp.sharpness > soft.sharpness * 3, `${sharp.sharpness} vs ${soft.sharpness}`);
  assert.equal(sharp.blown, 0);
  assert.ok(blown.blown > 0.3, String(blown.blown));
  assert.ok(hamming(sharp.hash, soft.hash) <= 14, 'a blurred copy is still the same scene');
  assert.ok(hamming(sharp.hash, other.hash) > 14, 'a different scene is not');
});

test('bursts: grouped by time and look; the best of each group is picked', () => {
  const a = analyzePixels(image({ seed: 0 }));
  const aSoft = analyzePixels(image({ seed: 0, blur: 4 }));
  const b = analyzePixels(image({ seed: 1 }));
  const t0 = Date.UTC(2025, 5, 1, 15, 0, 0);
  const items: RankInput[] = [
    { name: '_A730001.JPG', time: t0, ...aSoft },
    { name: '_A730002.JPG', time: t0 + 300, ...a }, // sharpest of the burst
    { name: '_A730003.JPG', time: t0 + 600, ...aSoft },
    { name: '_A730004.JPG', time: t0 + 60_000, ...b }, // a minute later: new moment
    { name: '_A730005.JPG', time: t0 + 60_400, ...a }, // close in time but a different scene
  ];
  const groups = groupSimilar(items, 2);
  assert.deepEqual(groups.map((g) => g.map((p) => p.name.slice(-6, -4))), [['01', '02', '03'], ['04'], ['05']]);

  const res = rankAlbum(items, { focus: true, exposure: true, similar: true, reject: false, burstSeconds: 2 });
  const by = Object.fromEntries(res.map((r) => [r.name.slice(-6, -4), r]));
  assert.equal(by['02'].flag, 'pick');
  assert.equal(by['02'].group?.best, true);
  assert.equal(by['02'].group?.size, 3);
  assert.equal(by['01'].flag, undefined, 'no automatic rejects unless asked');
  assert.ok(by['02'].stars > by['01'].stars);
  assert.match(by['02'].reason, /Best of 3 similar shots/);
  assert.equal(by['04'].group, undefined);
  assert.ok(by['02'].groupAvg && by['02'].groupAvg.focus < by['02'].scores.focus);

  const strict = rankAlbum(items, { focus: true, exposure: true, similar: true, reject: true, burstSeconds: 2 });
  assert.equal(strict.find((r) => r.name.endsWith('01.JPG'))?.flag, 'reject');
});

test('faces: in a burst the frame where nobody blinked and people smile at the camera wins', async () => {
  const { rankAlbum: rank, peopleScores } = await import('../core/rank');
  const a = analyzePixels(image({ seed: 0 }));
  const t0 = Date.UTC(2025, 5, 1, 15, 0, 0);
  const face = (eyes: number, looking: number, smile: number) => ({ area: 0.02, eyes, looking, smile, natural: 90 });
  const items = [
    // same sharpness, different faces: one blink / everyone good / one looks away
    { name: 'f1.JPG', time: t0, ...a, faces: [face(95, 90, 80), face(5, 90, 80)] },
    { name: 'f2.JPG', time: t0 + 300, ...a, faces: [face(95, 90, 85), face(90, 85, 80)] },
    { name: 'f3.JPG', time: t0 + 600, ...a, faces: [face(95, 20, 30), face(90, 85, 80)] },
  ];
  const res = rank(items, { focus: true, exposure: true, similar: true, reject: false, burstSeconds: 2, people: ['eyes', 'looking', 'smile', 'natural'] });
  const by = Object.fromEntries(res.map((r) => [r.name, r]));
  assert.equal(by['f2.JPG'].flag, 'pick');
  assert.ok(by['f1.JPG'].notes.includes('eyes closed'));
  assert.ok(by['f1.JPG'].scores.eyes < 40);
  assert.match(by['f2.JPG'].reason, /eyes open/);
  // A tiny face in the background is ignored.
  assert.equal(peopleScores([{ area: 0.0005, eyes: 0, looking: 0, smile: 0, natural: 0 }], ['eyes']), undefined);
});
