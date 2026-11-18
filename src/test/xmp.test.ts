import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultEdits, fromXmp, isDefault, normalizeEdits, toXmp } from '../core/xmp';

test('edits round-trip through the XMP sidecar', () => {
  const e = defaultEdits();
  e.exposure = 0.35;
  e.contrast = 18;
  e.highlights = -32;
  e.temp = 12;
  e.curves.rgb = [[0, 0], [64, 52], [192, 205], [255, 255]];
  e.curves.b = [[0, 10], [255, 240]];
  const xml = toXmp(e);
  assert.match(xml, /crs:Exposure2012="\+0\.35"/);
  assert.match(xml, /crs:Highlights2012="-32"/);
  assert.match(xml, /<rdf:li>64, 52<\/rdf:li>/);
  assert.deepEqual(fromXmp(xml), e);
  assert.ok(!isDefault(e));
  assert.ok(isDefault(fromXmp(toXmp(defaultEdits()))));
});

test('untrusted edits are clamped and cleaned', () => {
  const e = normalizeEdits({ exposure: 99, contrast: -500, shadows: 'x', curves: { rgb: [[300, -5], [0, 0], [0, 9], 'bad'] } });
  assert.equal(e.exposure, 5);
  assert.equal(e.contrast, -100);
  assert.equal(e.shadows, 0);
  assert.deepEqual(e.curves.rgb, [[0, 0], [255, 0]]);
  assert.deepEqual(normalizeEdits(null), defaultEdits());
});

test('rating, flag and Auto-Rank details live in the same sidecar as edits', async () => {
  const { readSidecar, toXmp: write, emptySidecar, isEmptySidecar } = await import('../core/xmp');
  const sc = emptySidecar();
  assert.ok(isEmptySidecar(sc));
  sc.rating = 4;
  sc.flag = 'pick';
  sc.edits.exposure = 0.5;
  sc.auto = { scores: { focus: 86, exposure: 96 }, group: { id: 'g1', size: 5, best: true }, reason: 'Best of 5 "similar" <shots>', at: '2026-11-18T10:00:00Z' };
  const back = readSidecar(write(sc));
  assert.equal(back.rating, 4);
  assert.equal(back.flag, 'pick');
  assert.equal(back.edits.exposure, 0.5);
  assert.deepEqual(back.auto, sc.auto);
  assert.ok(!isEmptySidecar(back));
  // Files written before culling existed still read (no rating attribute).
  assert.equal(readSidecar(write(emptySidecar().edits)).rating, 0);
});
