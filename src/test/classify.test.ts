import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyByMetadata,
  CONFIDENT,
  hasNoCameraSigns,
  isScreenSize,
  jpegSizeFrom,
  pngSizeFrom,
  TAG_SCREENSHOT,
} from '../core/classify';
import { ExifInfo } from '../core/exif';

/** A camera photo's EXIF. */
const camera: ExifInfo = {
  make: 'FUJIFILM',
  model: 'X-T4',
  lens: 'XF35mmF1.4 R',
  dateTaken: '2024:06:01 10:00:00',
  exposureTime: 1 / 250,
  fNumber: 2,
  iso: 160,
  focalLength: 35,
  width: 6240,
  height: 4160,
};

const tagged = (name: string, exif?: ExifInfo, width?: number, height?: number) => {
  const v = classifyByMetadata({ name, exif, width, height });
  return v.confidence >= CONFIDENT ? v.tags : [];
};

test('platform screenshot names are recognised', () => {
  for (const name of [
    'Screenshot 2024-01-02 at 10.11.12.png',
    'Screen Shot 2019-03-04 at 1.02.03 PM.png',
    'Screenshot_20240101-101112.png',
    'Screenshot (3).png',
    'Screenshot.png',
    'Simulator Screen Shot - iPhone 15 - 2024-01-01.png',
    'Captura de pantalla 2024-01-01.png',
    'Bildschirmfoto 2024-01-01 um 10.11.12.png',
  ]) {
    assert.deepEqual(tagged(name), [TAG_SCREENSHOT], name);
  }
});

test('the Software tag names a screen grabber', () => {
  assert.deepEqual(tagged('IMG_0001.png', { software: 'Screenshot' }), [TAG_SCREENSHOT]);
  assert.deepEqual(tagged('grabbed.jpg', { software: 'Screen Shot' }), [TAG_SCREENSHOT]);
  // Camera firmware in the same field is not a screenshot.
  assert.deepEqual(tagged('DSCF1234.jpg', { ...camera, software: 'Digital Camera X-T4 Ver4.00' }), []);
});

test('camera photos are never tagged', () => {
  assert.deepEqual(tagged('DSCF1234.jpg', camera), []);
  assert.deepEqual(tagged('IMG_0001.jpg', { make: 'Apple', model: 'iPhone 15 Pro', exposureTime: 1 / 120, iso: 50 }), []);
  // Even one named confusingly, as long as the name isn't the platform's own shape.
  assert.deepEqual(tagged('my-screen-door.jpg', camera), []);
});

test('a RAW file is never a screenshot', () => {
  assert.deepEqual(tagged('DSCF1234.raf', undefined), []);
  assert.deepEqual(tagged('IMG_1234.dng', undefined), []);
});

test('a PNG with no camera data needs a screen size before it counts', () => {
  // A photo exported or converted to PNG loses its EXIF, and on iOS a screenshot and a photo are
  // both IMG_nnnn.PNG — so the format alone must not be enough. Real case: a 2778x2084 group
  // photo, 4:3 and no EXIF at all, which an earlier rule tagged as a screenshot.
  const photo = classifyByMetadata({ name: 'IMG_8032.PNG', width: 2778, height: 2084 });
  assert.deepEqual(photo.tags, []);
  assert.ok(photo.confidence < CONFIDENT);
  assert.deepEqual(classifyByMetadata({ name: 'image.png' }).tags, []);
  // With a screen size behind it, it counts.
  const sized = classifyByMetadata({ name: 'image.png', width: 1170, height: 2532 });
  assert.deepEqual(sized.tags, [TAG_SCREENSHOT]);
  assert.ok(sized.confidence >= CONFIDENT);
});

test('a JPEG stripped of its EXIF is only tagged when it is screen-sized', () => {
  // A photo that lost its EXIF passing through a chat app: not enough to call it a screenshot.
  assert.deepEqual(tagged('IMG-20240101-WA0001.jpg', undefined, 1600, 1200), []);
  // Nor is a size photos are routinely exported at, however screen-like it looks.
  assert.deepEqual(tagged('photo.jpg', undefined, 1920, 1080), []);
  // A tall phone screen is another matter.
  assert.deepEqual(tagged('photo.jpg', undefined, 1170, 2532), [TAG_SCREENSHOT]);
});

test('screen sizes match either way round', () => {
  assert.ok(isScreenSize(1170, 2532));
  assert.ok(isScreenSize(2532, 1170));
  assert.ok(isScreenSize(1440, 900));
  assert.ok(!isScreenSize(6240, 4160));
  assert.ok(!isScreenSize(undefined, 1080));
});

test('hasNoCameraSigns looks at every camera field', () => {
  assert.ok(hasNoCameraSigns(undefined));
  assert.ok(hasNoCameraSigns({}));
  assert.ok(hasNoCameraSigns({ dateTaken: '2024:01:01 00:00:00', orientation: 1 }));
  assert.ok(!hasNoCameraSigns({ iso: 100 }));
  assert.ok(!hasNoCameraSigns({ make: 'Canon' }));
  assert.ok(!hasNoCameraSigns(camera));
});

test('a PNG’s size is read from its IHDR chunk', () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  assert.deepEqual(pngSizeFrom(png(1170, 2532)), { width: 1170, height: 2532 });
  // Wide enough that the top bit of the width is set: must not come back negative.
  assert.deepEqual(pngSizeFrom(png(3_000_000_000, 10)), { width: 3_000_000_000, height: 10 });
  assert.equal(pngSizeFrom(png(1170, 2532).subarray(0, 20)), undefined); // truncated
  assert.equal(pngSizeFrom(Buffer.from('not a png at all, not even close')), undefined);
  // A PNG signature but some other first chunk.
  const odd = png(10, 10);
  odd.write('IDAT', 12, 'latin1');
  assert.equal(pngSizeFrom(odd), undefined);
});

test('the true size from the header beats stale EXIF dimensions', () => {
  // Real case: a baby photo cropped out of a 1284x2778 iPhone screenshot. The editor left the
  // old dimensions in EXIF, so the screen-size rule matched and tagged a photo.
  const exif = { dateTaken: '2022:03:08 12:30:27', orientation: 1, width: 1284, height: 2778 };
  const stale = classifyByMetadata({ name: 'IMG_8581.JPEG', exif });
  assert.deepEqual(stale.tags, [TAG_SCREENSHOT], 'EXIF alone still matches — that is the trap');
  const real = classifyByMetadata({ name: 'IMG_8581.JPEG', exif, width: 1284, height: 1253 });
  assert.deepEqual(real.tags, [], 'the header size must win');
});

test('a JPEG’s true size comes from its SOF marker', () => {
  const jpeg = (w: number, h: number) => {
    const b = Buffer.alloc(24);
    b.writeUInt16BE(0xffd8, 0);
    b.writeUInt16BE(0xffe0, 2); // APP0 to skip over
    b.writeUInt16BE(6, 4);
    b.writeUInt16BE(0xffc0, 10); // SOF0
    b.writeUInt16BE(11, 12);
    b[14] = 8;
    b.writeUInt16BE(h, 15);
    b.writeUInt16BE(w, 17);
    return b;
  };
  assert.deepEqual(jpegSizeFrom(jpeg(1284, 1253)), { width: 1284, height: 1253 });
  assert.equal(jpegSizeFrom(Buffer.from([0x89, 0x50, 0x4e, 0x47])), undefined); // a PNG
  assert.equal(jpegSizeFrom(Buffer.alloc(4)), undefined);
});

test('sizes photos are commonly exported at are not treated as screens', () => {
  // These produced false positives on a real library: 2048x1536 is an iPad screen and also
  // classic QXGA; 4:3 and 16:9 are the two most common photo aspects there are.
  for (const [w, h] of [[2048, 1536], [1536, 2048], [1920, 1080], [3840, 2160], [2560, 1440], [1080, 1920]]) {
    assert.ok(!isScreenSize(w, h), `${w}x${h} must not count as a screen`);
  }
  // Tall phone screens stay, since a photo is never exactly these.
  assert.ok(isScreenSize(1170, 2532));
  assert.ok(isScreenSize(1284, 2778));
  assert.ok(isScreenSize(2880, 1800));
});
