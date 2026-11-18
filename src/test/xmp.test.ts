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
