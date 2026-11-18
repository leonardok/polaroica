import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePixels, hamming } from '../core/analyze';
import { groupSimilar, rankAlbum, RankInput, subjectFocus } from '../core/rank';

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

/** A 16-hex hash with the first `flip` bits flipped (so `hamming` to hash(0) is `flip`). */
function hashWith(flip: number): string {
  let bitsLeft = flip;
  let hex = '';
  for (let i = 0; i < 8; i++) {
    const n = Math.max(0, Math.min(8, bitsLeft));
    bitsLeft -= n;
    hex += ((0xff << (8 - n)) & 0xff).toString(16).padStart(2, '0');
  }
  return hex;
}

/** A colour layout (12×8 cells) of one flat colour. */
function layoutOf(r: number, g: number, b: number): string {
  const cell = [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  return cell.repeat(96);
}

test('scenes: the same pose shot again within a minute stacks; a reframe or a burst of another scene does not', () => {
  const t0 = Date.UTC(2023, 11, 24, 22, 0, 0);
  const warm = layoutOf(200, 150, 100);
  const warmish = layoutOf(215, 160, 110); // same scene, people moved: ~20 apart
  const other = layoutOf(120, 120, 160); // reframed / another scene
  const p = (name: string, s: number, flip: number, layout: string): RankInput => ({ name, time: t0 + s * 1000, sharpness: 10, blown: 0, hash: hashWith(flip), layout });
  assert.equal(hamming(hashWith(0), hashWith(18)), 18);

  const items = [
    p('_A732858.jpg', 0, 0, warm),
    p('_A732859.jpg', 1, 3, warm), // burst
    p('_A732861.jpg', 9, 18, warmish), // 8 s later, hash 18 away, same colours: same scene
    p('_A732863.jpg', 25, 16, warmish), // 16 s later
    p('_A732870.jpg', 40, 19, other), // 15 s later, hash close-ish but different colours: reframed
    p('_A732871.jpg', 41, 19, other), // its burst
    p('_A732880.jpg', 200, 0, warm), // same look, but minutes later: a new moment
  ];
  const groups = groupSimilar(items, 2, 60).map((g) => g.map((x) => x.name.slice(5, 8)));
  assert.deepEqual(groups, [['858', '859', '861', '863'], ['870', '871'], ['880']]);

  // Scene window off: only bursts stack.
  const strict = groupSimilar(items, 2, 0).map((g) => g.map((x) => x.name.slice(5, 8)));
  assert.deepEqual(strict, [['858', '859'], ['861'], ['863'], ['870', '871'], ['880']]);
});

test('rejects you keep are never the best of a group; the best kept shot is picked instead', () => {
  const t0 = Date.UTC(2023, 11, 24, 22, 0, 0);
  const p = (name: string, s: number, sharpness: number, rejected = false): RankInput => ({ name, time: t0 + s * 1000, sharpness, blown: 0, hash: hashWith(0), rejected });
  const opts = { focus: true, exposure: true, similar: true, reject: false, burstSeconds: 2 };
  const res = rankAlbum([p('a.jpg', 0, 50, true), p('b.jpg', 1, 30), p('c.jpg', 2, 10)], opts);
  const by = (n: string) => res.find((r) => r.name === n)!;
  assert.equal(by('a.jpg').group?.best, false, 'the sharpest one is rejected, so not the best');
  assert.equal(by('a.jpg').flag, undefined);
  assert.equal(by('b.jpg').group?.best, true);
  assert.equal(by('b.jpg').flag, 'pick');

  const all = rankAlbum([p('a.jpg', 0, 50, true), p('b.jpg', 1, 30, true)], opts);
  assert.ok(all.every((r) => !r.group?.best && r.flag !== 'pick'), 'all rejected: nothing picked');
});

test('near-ties of the best are kept: no reject, full stars; a long burst still keeps only three', () => {
  const t0 = Date.UTC(2023, 11, 24, 23, 48, 0);
  const p = (name: string, s: number, focus: number): RankInput => ({ name, time: t0 + s * 1000, sharpness: 1, blown: 0, hash: hashWith(0), frameFocus: focus });
  const opts = { focus: true, exposure: true, similar: true, reject: true, burstSeconds: 2 };

  // Two excellent shots a hair apart, one clearly weaker.
  const res = rankAlbum([p('_A732889.jpg', 0, 97), p('_A732890.jpg', 1, 100), p('_A732891.jpg', 2, 70)], opts);
  const by = (n: string) => res.find((r) => r.name === n)!;
  assert.equal(by('_A732890.jpg').flag, 'pick');
  assert.equal(by('_A732889.jpg').flag, undefined, 'a near-tie is not rejected');
  assert.equal(by('_A732889.jpg').group?.kept, true);
  assert.equal(by('_A732889.jpg').stars, by('_A732890.jpg').stars, 'and keeps its full stars');
  assert.match(by('_A732889.jpg').reason, /about as good as the best/);
  assert.equal(by('_A732891.jpg').flag, 'reject', 'clearly weaker shots are still rejected');
  assert.equal(by('_A732891.jpg').group?.kept, undefined);

  // Six equally good frames: the best plus two near-ties stay, the rest are rejected.
  const burst = rankAlbum([0, 1, 2, 3, 4, 5].map((i) => p(`b${i}.jpg`, i * 0.3, 98)), opts);
  assert.equal(burst.filter((r) => r.flag === 'pick').length, 1);
  assert.equal(burst.filter((r) => r.group?.kept).length, 2);
  assert.equal(burst.filter((r) => r.flag === 'reject').length, 3);
});

test('focus: measured on the subject, not the whole frame', () => {
  const face = (area: number, focus: number) => ({ area, eyes: 100, looking: 100, smile: 50, natural: 100, focus });
  const base = { name: 'x.jpg', sharpness: 1, blown: 0, hash: hashWith(0), frameFocus: 40 };
  // Portrait: sharp face, blurred background (low frame focus): the face decides.
  assert.equal(subjectFocus({ ...base, faces: [face(0.09, 95)] }), 95);
  // Missed focus: background sharp, face soft.
  assert.equal(subjectFocus({ ...base, frameFocus: 95, faces: [face(0.09, 10)] }), 10);
  // Group: the sharpest of the main faces (a small face far behind doesn't count).
  assert.equal(subjectFocus({ ...base, faces: [face(0.02, 80), face(0.025, 60), face(0.003, 99)] }), 80);
  // Sharp figurine in front, a small blurred child in the background: the frame decides.
  assert.equal(subjectFocus({ ...base, frameFocus: 92, faces: [face(0.004, 5)] }), 92);
  // No faces: the frame.
  assert.equal(subjectFocus({ ...base, faces: [] }), 40);
});
