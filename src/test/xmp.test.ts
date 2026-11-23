import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultEdits,
  emptySidecar,
  fromXmp,
  isDefault,
  isEmptySidecar,
  normalizeEdits,
  normalizeTags,
  readSidecar,
  sameTag,
  Sidecar,
  toXmp,
} from '../core/xmp';

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

test('Clarity, Dehaze, Detail and Color round-trip and are range-checked', () => {
  const e = defaultEdits();
  Object.assign(e, { clarity: 25, dehaze: -10, sharpness: 40, noise: 30, moire: 15, defringe: 60, colorHue: 210, colorAmount: 35 });
  const xml = toXmp(e);
  assert.match(xml, /crs:Clarity2012="\+25"/);
  assert.match(xml, /polaroica:Moire="\+15"/);
  assert.deepEqual(fromXmp(xml), e);
  const n = normalizeEdits({ noise: -40, colorHue: 400, colorAmount: 150, sharpness: -300 });
  assert.equal(n.noise, 0);
  assert.equal(n.colorHue, 359);
  assert.equal(n.colorAmount, 100);
  assert.equal(n.sharpness, -100);
  // A hue with no strength is no edit.
  assert.ok(isDefault(normalizeEdits({ colorHue: 120 })));
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

test('sidecars written before the rename (vsphoto: prefix) are still read', async () => {
  const { readSidecar } = await import('../core/xmp');
  const old = `<rdf:Description xmlns:vsphoto="https://github.com/leonardok/vsphoto/ns/1.0/"
   xmp:Rating="4"
   vsphoto:Flag="pick"
   vsphoto:AutoRank="{&quot;focus&quot;:80}">`;
  const sc = readSidecar(old);
  assert.equal(sc.rating, 4);
  assert.equal(sc.flag, 'pick');
  assert.deepEqual(sc.auto, { focus: 80 });
});

test('tags round-trip as a dc:subject bag, and auto tags are marked', () => {
  const sc: Sidecar = { ...emptySidecar(), tags: ['Screenshot', 'Receipts'], autoTags: ['Screenshot'] };
  const xml = toXmp(sc);
  assert.match(xml, /xmlns:dc="http:\/\/purl\.org\/dc\/elements\/1\.1\//);
  assert.match(xml, /<dc:subject>/);
  assert.match(xml, /<rdf:li>Screenshot<\/rdf:li>/);
  assert.match(xml, /<rdf:li>Receipts<\/rdf:li>/);
  const back = readSidecar(xml);
  assert.deepEqual(back.tags, ['Screenshot', 'Receipts']);
  assert.deepEqual(back.autoTags, ['Screenshot']);
  // Tags alone are enough to keep a sidecar: it isn't "empty".
  assert.ok(!isEmptySidecar(sc));
  assert.ok(isEmptySidecar(emptySidecar()));
});

test('a sidecar with no tags writes no dc:subject', () => {
  const xml = toXmp(emptySidecar());
  assert.ok(!xml.includes('dc:subject'));
  assert.equal(readSidecar(xml).tags, undefined);
});

test('tags are trimmed, de-duplicated case-insensitively, and keep their order', () => {
  assert.deepEqual(normalizeTags([' Screenshot ', 'screenshot', 'Receipts', '', '  ', 'RECEIPTS']), ['Screenshot', 'Receipts']);
  assert.deepEqual(normalizeTags(['Bank  statements']), ['Bank statements']);
  assert.ok(sameTag('Screenshot', ' screenshot '));
  assert.ok(!sameTag('Screenshot', 'Screenshots'));
  // A repeat in the file is collapsed on the way back out.
  const back = readSidecar(toXmp({ ...emptySidecar(), tags: ['Doc', 'doc'] }));
  assert.deepEqual(back.tags, ['Doc']);
});

test('tags with XML characters survive the round trip', () => {
  const tags = ['Bills & Receipts', '<Scans>', 'A "quoted" one'];
  const back = readSidecar(toXmp({ ...emptySidecar(), tags }));
  assert.deepEqual(back.tags, tags);
});

test('an AutoTags mark for a tag that is gone is ignored', () => {
  // Hand-edited, or a tag removed elsewhere: the mark must not resurrect it.
  const xml = toXmp({ ...emptySidecar(), tags: ['Receipts'] }).replace(
    'crs:HasSettings="True"',
    'crs:HasSettings="True"\n   polaroica:AutoTags="[&quot;Screenshot&quot;]"',
  );
  const back = readSidecar(xml);
  assert.deepEqual(back.tags, ['Receipts']);
  assert.equal(back.autoTags, undefined);
});

test('a dc:subject attribute written by another program is read as a list', () => {
  const xml = toXmp(emptySidecar()).replace('crs:HasSettings="True"', 'crs:HasSettings="True"\n   dc:subject="Screenshot; Receipts"');
  assert.deepEqual(readSidecar(xml).tags, ['Screenshot', 'Receipts']);
});

test('tags do not disturb the edits, rating or flag in the same sidecar', () => {
  const edits = defaultEdits();
  edits.exposure = 0.5;
  const sc: Sidecar = { edits, rating: 4, flag: 'pick', tags: ['Screenshot'] };
  const back = readSidecar(toXmp(sc));
  assert.equal(back.rating, 4);
  assert.equal(back.flag, 'pick');
  assert.equal(back.edits.exposure, 0.5);
  assert.deepEqual(back.tags, ['Screenshot']);
});
