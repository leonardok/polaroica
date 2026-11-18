import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { makeThumb } from '../core/codec';
import { embeddedThumbnail, jpegSegments, mpfPreviews, readExif } from '../core/exif';
import { downscale, orient, trimBars } from '../core/image';

const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
const root = path.join(__dirname, '..', '..', 'node_modules', '@jsquash');

/** Solid-colour JPEG via the jSquash encoder (test helper only). */
async function jpeg(w: number, h: number, rgb: [number, number, number], bars = 0): Promise<Buffer> {
  const enc = await importEsm(pathToFileURL(path.join(root, 'jpeg/encode.js')).href);
  await enc.init(await WebAssembly.compile(fs.readFileSync(path.join(root, 'jpeg/codec/enc/mozjpeg_enc.wasm'))));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const bar = y < bars || y >= h - bars;
      data[i] = bar ? 0 : rgb[0];
      data[i + 1] = bar ? 0 : rgb[1];
      data[i + 2] = bar ? 0 : rgb[2];
      data[i + 3] = 255;
    }
  }
  return Buffer.from(await enc.default({ data, width: w, height: h }, { quality: 90 }));
}

/** A camera-like JPEG: EXIF (orientation 6 + IFD1 thumbnail) and an MPF preview at the end. */
async function cameraJpeg(xmpPadding = 0) {
  const main = await jpeg(1200, 800, [200, 40, 40]); // red
  const preview = await jpeg(600, 400, [40, 200, 40]); // green: proves the preview was used
  const thumb = await jpeg(160, 120, [40, 40, 200], 13); // blue, letterboxed 4:3

  // APP1 Exif: TIFF with IFD0 (Orientation=6) -> IFD1 (thumbnail offset/length).
  const tiffLen = 8 + 2 + 12 + 4 + 2 + 24 + 4;
  const tiff = Buffer.alloc(tiffLen + thumb.length);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(6, 18);
  tiff.writeUInt32LE(26, 22); // next IFD
  tiff.writeUInt16LE(2, 26);
  tiff.writeUInt16LE(0x0201, 28); tiff.writeUInt16LE(4, 30); tiff.writeUInt32LE(1, 32); tiff.writeUInt32LE(tiffLen, 36);
  tiff.writeUInt16LE(0x0202, 40); tiff.writeUInt16LE(4, 42); tiff.writeUInt32LE(1, 44); tiff.writeUInt32LE(thumb.length, 48);
  tiff.writeUInt32LE(0, 52);
  thumb.copy(tiff, tiffLen);
  const app1Body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (app1Body.length + 2) >> 8, (app1Body.length + 2) & 0xff]), app1Body]);

  // APP2 MPF: MP header (TIFF-like) with NumberOfImages=2 and two 16-byte MP entries.
  const mp = Buffer.alloc(8 + 2 + 24 + 4 + 32);
  mp.write('II', 0, 'latin1');
  mp.writeUInt16LE(42, 2);
  mp.writeUInt32LE(8, 4);
  mp.writeUInt16LE(2, 8);
  mp.writeUInt16LE(0xb001, 10); mp.writeUInt16LE(4, 12); mp.writeUInt32LE(1, 14); mp.writeUInt32LE(2, 18);
  mp.writeUInt16LE(0xb002, 22); mp.writeUInt16LE(7, 24); mp.writeUInt32LE(32, 26); mp.writeUInt32LE(38, 30);
  mp.writeUInt32LE(0, 34);
  const app2Body = Buffer.concat([Buffer.from('MPF\0', 'latin1'), mp]);
  const app2 = Buffer.concat([Buffer.from([0xff, 0xe2, (app2Body.length + 2) >> 8, (app2Body.length + 2) & 0xff]), app2Body]);

  // Optional XMP segment (as editing apps add) between EXIF and MPF.
  // Optional XMP + ICC profile segments (as editing apps add) between EXIF and MPF.
  const seg = (marker: number, id: string, pad: number) => {
    const body = Buffer.concat([Buffer.from(id + '\0', 'latin1'), Buffer.alloc(pad, 0x20)]);
    return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  };
  const xmp = xmpPadding
    ? Buffer.concat([seg(0xe1, 'http://ns.adobe.com/xap/1.0/', xmpPadding), seg(0xe2, 'ICC_PROFILE', xmpPadding)])
    : Buffer.alloc(0);
  const body = main.subarray(2); // main image without its SOI
  const file = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, xmp, app2, body, preview]);
  const mpHeaderStart = 2 + app1.length + xmp.length + 4 + 4; // after FFE2 + length + "MPF\0"
  const previewStart = 2 + app1.length + xmp.length + app2.length + body.length;
  // MP entries: primary (offset 0), preview (offset relative to the MP header).
  const entries = mpHeaderStart + 38;
  file.writeUInt32LE(0x030000, entries); file.writeUInt32LE(previewStart, entries + 4); file.writeUInt32LE(0, entries + 8);
  file.writeUInt32LE(0x010002, entries + 16); file.writeUInt32LE(preview.length, entries + 20);
  file.writeUInt32LE(previewStart - mpHeaderStart, entries + 24);
  return { file, preview, previewStart };
}

test('camera JPEG: quick thumbnail from EXIF (bars trimmed, rotated), sharp one from the MPF preview', async () => {
  const { file, preview, previewStart } = await cameraJpeg();
  const head = file.subarray(0, 128 * 1024);
  assert.equal(readExif(head)?.orientation, 6);

  const previews = mpfPreviews(head);
  assert.deepEqual(previews[0], { offset: previewStart, length: preview.length });

  const thumbRange = embeddedThumbnail(head)!;
  const quick = await makeThumb(head.subarray(thumbRange.offset, thumbRange.offset + thumbRange.length), {
    px: 256,
    orientation: 6,
    trim: true,
  });
  // 160x120 minus 13px bars top and bottom = 160x94, rotated 90° -> 94x160.
  assert.equal(quick.sourceWidth, 160);
  assert.deepEqual([quick.w, quick.h], [94, 160]);

  const p = previews[0];
  const sharp = await makeThumb(file.subarray(p.offset, p.offset + p.length), { px: 256, orientation: 6 });
  assert.deepEqual([sharp.sourceWidth, sharp.sourceHeight], [600, 400]);
  assert.deepEqual([sharp.w, sharp.h], [171, 256]);
  assert.equal(sharp.data.toString('latin1', 0, 4), 'RIFF');
  assert.equal(sharp.data.toString('latin1', 8, 12), 'WEBP');
});

test('pixel helpers: downscale averages, orient rotates, trimBars needs matching bars', () => {
  const img = { data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]), width: 4, height: 1 };
  const d = downscale(img, 2);
  assert.deepEqual([d.width, d.height], [2, 1]);
  assert.equal(d.data[0], 128); // average of black and white

  const tall = orient({ data: new Uint8ClampedArray(3 * 2 * 4), width: 3, height: 2 }, 6);
  assert.deepEqual([tall.width, tall.height], [2, 3]);

  // A dark band at the top only (a night sky) is not trimmed.
  const w = 4, h = 8;
  const px = new Uint8ClampedArray(w * h * 4).fill(200);
  for (let i = 0; i < w * 2 * 4; i++) px[i] = 0;
  assert.equal(trimBars({ data: px, width: w, height: h }).height, 8);
});

test('MPF index behind a large XMP segment: found once enough of the header is read', async () => {
  const { file, preview, previewStart } = await cameraJpeg(40000);
  const short = file.subarray(0, 72 * 1024);
  assert.equal(mpfPreviews(short).length, 0, 'not within the first 72 KB');
  assert.equal(jpegSegments(short).complete, false, 'so the header is known to continue');
  assert.match(jpegSegments(short).summary, /APP1\(Exif\).*APP1\(http:\/\/ns\.ad.*APP2\(ICC_PROFILE\)/);
  const long = file.subarray(0, 512 * 1024);
  assert.deepEqual(mpfPreviews(long)[0], { offset: previewStart, length: preview.length });
  assert.equal(jpegSegments(long).complete, true);
});
