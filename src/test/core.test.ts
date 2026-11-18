import assert from 'node:assert/strict';
import { fromWire, toWire } from '../core/wire';
import { test } from 'node:test';
import { cameraLabel, embeddedPreviews, embeddedThumbnail, formatExifDate, formatExposure, isBrowserJpeg, readExif } from '../core/exif';
import { compareNames, extensionOf, isDisplayable, isHiddenFolder, isPhoto, isRaw, nextFreeName, sortPhotos } from '../core/images';
import { candidateLocalPaths, defaultLibraryName, formatUnc, looksLikeNetworkPath, parseSmbAddress } from '../core/smb';

test('photo file types', () => {
  assert.equal(extensionOf('DSC_4188.NEF'), 'nef');
  assert.equal(extensionOf('noext'), '');
  assert.equal(extensionOf('.hidden'), '');
  assert.ok(isPhoto('a.JPG'));
  assert.ok(isPhoto('a.nef'));
  assert.ok(isPhoto('a.heic'));
  assert.ok(!isPhoto('a.txt'));
  assert.ok(!isPhoto('._a.jpg'), 'macOS resource fork');
  assert.ok(isDisplayable('a.webp'));
  assert.ok(!isDisplayable('a.cr2'));
  assert.ok(isRaw('a.ARW'));
  assert.ok(isHiddenFolder('@eaDir'));
  assert.ok(isHiddenFolder('.thumbnails'));
  assert.ok(!isHiddenFolder('2026-10 Patagonia'));
});

test('natural sort and sort keys', () => {
  assert.ok(compareNames('IMG_2.jpg', 'IMG_10.jpg') < 0);
  const ps = [
    { name: 'b.jpg', size: 1, mtime: 30 },
    { name: 'a10.jpg', size: 3, mtime: 10 },
    { name: 'a2.jpg', size: 2, mtime: 20 },
  ];
  assert.deepEqual(sortPhotos(ps, 'name').map((p) => p.name), ['a2.jpg', 'a10.jpg', 'b.jpg']);
  assert.deepEqual(sortPhotos(ps, 'modified').map((p) => p.name), ['a10.jpg', 'a2.jpg', 'b.jpg']);
  assert.deepEqual(sortPhotos(ps, 'size', true).map((p) => p.name), ['a10.jpg', 'a2.jpg', 'b.jpg']);
});

test('nextFreeName keeps the extension and counts up', () => {
  const taken = new Set(['DSC_1.NEF (1)', 'photo (1).jpg']);
  assert.equal(nextFreeName('photo.jpg', (n) => taken.has(n)), 'photo (2).jpg');
  assert.equal(nextFreeName('photo (1).jpg', (n) => taken.has(n)), 'photo (2).jpg');
  assert.equal(nextFreeName('DSC_1.NEF', () => false), 'DSC_1 (1).NEF');
  assert.equal(nextFreeName('folder', () => false), 'folder (1)');
});

test('parse SMB addresses', () => {
  assert.deepEqual(parseSmbAddress('\\\\nas.local\\photos'), { host: 'nas.local', share: 'photos', rest: [] });
  assert.deepEqual(parseSmbAddress('smb://me@nas.local:445/photos/Archive/2026'), {
    host: 'nas.local',
    share: 'photos',
    rest: ['Archive', '2026'],
  });
  assert.deepEqual(parseSmbAddress('//nas/My%20Photos'), { host: 'nas', share: 'My Photos', rest: [] });
  assert.equal(parseSmbAddress('/Volumes/photos'), undefined);
  assert.equal(parseSmbAddress('smb://nas'), undefined);
  assert.equal(formatUnc({ host: 'nas', share: 'photos', rest: ['a'] }), '\\\\nas\\photos\\a');
  assert.equal(defaultLibraryName({ host: 'nas', share: 'photos', rest: [] }), 'photos');
  assert.equal(defaultLibraryName({ host: 'nas', share: 'photos', rest: ['Archive'] }), 'Archive');
});

test('where an SMB share shows up locally', () => {
  const a = { host: 'NAS.local', share: 'Photos', rest: ['2026'] };
  assert.deepEqual(candidateLocalPaths(a, { platform: 'win32' }), ['\\\\NAS.local\\Photos\\2026']);
  assert.equal(candidateLocalPaths(a, { platform: 'darwin' })[0], '/Volumes/Photos/2026');
  assert.equal(
    candidateLocalPaths(a, { platform: 'linux', uid: 1000 })[0],
    '/run/user/1000/gvfs/smb-share:server=nas.local,share=photos/2026',
  );
  assert.ok(looksLikeNetworkPath('\\\\nas\\photos', 'win32'));
  assert.ok(looksLikeNetworkPath('/Volumes/photos', 'darwin'));
  assert.ok(!looksLikeNetworkPath('/Users/me/Pictures', 'darwin'));
  assert.ok(looksLikeNetworkPath('/run/user/1000/gvfs/smb-share:server=nas,share=p', 'linux'));
});

/** Builds a little-endian TIFF with IFD0 (Make, Model, ExifIFD) and an Exif IFD. */
function sampleTiff(): Uint8Array {
  const buf = new Uint8Array(400);
  const v = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, 8, true);
  let strOff = 300;
  const strings: Array<[number, string]> = [];
  const entry = (at: number, tag: number, type: number, count: number, value: number) => {
    v.setUint16(at, tag, true);
    v.setUint16(at + 2, type, true);
    v.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) {
      v.setUint16(at + 8, value, true);
    } else {
      v.setUint32(at + 8, value, true);
    }
  };
  const str = (s: string) => {
    const off = strOff;
    strings.push([off, s]);
    strOff += s.length + 1;
    return off;
  };
  // IFD0 at 8: 3 entries
  v.setUint16(8, 3, true);
  entry(10, 0x010f, 2, 18, str('NIKON CORPORATION'));
  entry(22, 0x0110, 2, 10, str('NIKON Z 6'));
  entry(34, 0x8769, 4, 1, 100);
  // Exif IFD at 100: 4 entries
  v.setUint16(100, 4, true);
  entry(102, 0x829a, 5, 1, 200); // ExposureTime rational at 200
  entry(114, 0x829d, 5, 1, 208); // FNumber at 208
  entry(126, 0x8827, 3, 1, 200); // ISO 200
  entry(138, 0x9003, 2, 20, str('2026:10:14 07:42:10'));
  v.setUint32(200, 1, true);
  v.setUint32(204, 500, true);
  v.setUint32(208, 8, true);
  v.setUint32(212, 1, true);
  for (const [off, s] of strings) {
    for (let i = 0; i < s.length; i++) {
      buf[off + i] = s.charCodeAt(i);
    }
  }
  return buf;
}

test('read EXIF from TIFF (RAW) and JPEG', () => {
  const tiff = sampleTiff();
  const info = readExif(tiff);
  assert.ok(info);
  assert.equal(info.make, 'NIKON CORPORATION');
  assert.equal(info.model, 'NIKON Z 6');
  assert.equal(info.exposureTime, 1 / 500);
  assert.equal(info.fNumber, 8);
  assert.equal(info.iso, 200);
  assert.equal(info.dateTaken, '2026:10:14 07:42:10');
  assert.equal(cameraLabel(info), 'NIKON Z 6');

  // Same TIFF wrapped in a JPEG APP1 "Exif\0\0" segment.
  const app1Len = 2 + 6 + tiff.length;
  const jpeg = new Uint8Array(4 + app1Len + 2);
  jpeg.set([0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 0xff]);
  jpeg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  jpeg.set(tiff, 12);
  jpeg.set([0xff, 0xd9], 12 + tiff.length);
  const fromJpeg = readExif(jpeg);
  assert.equal(fromJpeg?.iso, 200);
  assert.equal(fromJpeg?.model, 'NIKON Z 6');

  assert.equal(readExif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), undefined);
  assert.equal(readExif(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0, 0])), undefined);
});

test('format exposure and dates', () => {
  assert.equal(formatExposure(1 / 500), '1/500');
  assert.equal(formatExposure(2.5), '2.5s');
  assert.equal(formatExifDate('2026:10:14 07:42:10'), '2026-10-14 07:42');
  assert.equal(cameraLabel({ make: 'Canon', model: 'EOS R5' }), 'Canon EOS R5');
});

/** TIFF with IFD0 (Make) -> IFD1 holding a tiny "JPEG" at a known offset. */
function tiffWithThumbnail(): { tiff: Uint8Array; jpegAt: number; jpeg: Uint8Array } {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 2, 0xff, 0xd9]);
  const buf = new Uint8Array(200);
  const v = new DataView(buf.buffer);
  buf.set([0x49, 0x49, 0x2a, 0x00]);
  v.setUint32(4, 8, true);
  // IFD0: one entry (Orientation = 1), next IFD at 26
  v.setUint16(8, 1, true);
  v.setUint16(10, 0x0112, true); v.setUint16(12, 3, true); v.setUint32(14, 1, true); v.setUint16(18, 1, true);
  v.setUint32(22, 26, true);
  // IFD1 at 26: JPEGInterchangeFormat (offset 100), JPEGInterchangeFormatLength
  v.setUint16(26, 2, true);
  v.setUint16(28, 0x0201, true); v.setUint16(30, 4, true); v.setUint32(32, 1, true); v.setUint32(36, 100, true);
  v.setUint16(40, 0x0202, true); v.setUint16(42, 4, true); v.setUint32(44, 1, true); v.setUint32(48, jpeg.length, true);
  v.setUint32(52, 0, true);
  buf.set(jpeg, 100);
  return { tiff: buf, jpegAt: 100, jpeg };
}

test('embedded EXIF thumbnail (JPEG) and RAW previews', () => {
  const { tiff, jpegAt, jpeg } = tiffWithThumbnail();
  // As a JPEG: APP1 Exif segment holding the TIFF.
  const app1Len = 2 + 6 + tiff.length;
  const file = new Uint8Array(4 + app1Len + 2);
  file.set([0xff, 0xd8, 0xff, 0xe1, app1Len >> 8, app1Len & 0xff]);
  file.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  file.set(tiff, 12);
  const r = embeddedThumbnail(file);
  assert.ok(r);
  assert.deepEqual(file.slice(r.offset, r.offset + r.length), jpeg);

  // As a TIFF-based RAW: the same IFD1 JPEG is a preview candidate at an absolute offset.
  const previews = embeddedPreviews(tiff);
  assert.deepEqual(previews, [{ offset: jpegAt, length: jpeg.length }]);
  assert.equal(embeddedThumbnail(tiff), undefined, 'RAW previews come from embeddedPreviews');

  // Fujifilm RAF header.
  const raf = new Uint8Array(100);
  raf.set(Array.from('FUJIFILMCCD-RAW', (c) => c.charCodeAt(0)));
  new DataView(raf.buffer).setUint32(84, 5000, false);
  new DataView(raf.buffer).setUint32(88, 1234, false);
  assert.deepEqual(embeddedPreviews(raf), [{ offset: 5000, length: 1234 }]);

  assert.ok(isBrowserJpeg(jpeg));
  assert.ok(!isBrowserJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xc3, 0, 2])), 'lossless JPEG (RAW sensor data)');
});

/** How VS Code serializes webview messages: typed arrays by constructor name, the rest as JSON. */
function vscodeSerialize(msg: unknown): unknown {
  const known = new Set(['Uint8Array', 'Int8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array']);
  const buffers: Uint8Array[] = [];
  const json = JSON.stringify(msg, function (_k, v) {
    const raw = this[_k];
    if (ArrayBuffer.isView(raw) && known.has(raw.constructor.name)) {
      buffers.push(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength).slice());
      return { $$buf: buffers.length - 1 };
    }
    return v;
  });
  return JSON.parse(json, (_k, v) => (v && typeof v === 'object' && '$$buf' in v ? buffers[v.$$buf] : v));
}

test('binary survives the trip to the webview', () => {
  const big = Buffer.alloc(1000, 7);
  const pooled = Buffer.from('hello'); // a slice of Node's shared pool
  const slice = big.subarray(10, 20);
  const raw = vscodeSerialize({ items: [{ data: big }] }) as { items: Array<{ data: unknown }> };
  assert.ok(!(raw.items[0].data instanceof Uint8Array), 'a bare Buffer does NOT survive (the bug)');

  const sent = vscodeSerialize(toWire({ type: 'thumbs', items: [{ name: 'a', data: big }, { name: 'b', data: pooled }, { name: 'c', data: slice }] })) as {
    items: Array<{ data: Uint8Array }>;
  };
  assert.ok(sent.items[0].data instanceof Uint8Array);
  assert.equal(sent.items[0].data.length, 1000);
  assert.deepEqual(Buffer.from(sent.items[1].data).toString(), 'hello');
  assert.equal(sent.items[2].data.length, 10);

  assert.deepEqual(fromWire(new Uint8Array([1, 2]))?.toJSON().data, [1, 2]);
  assert.deepEqual(fromWire({ type: 'Buffer', data: [3, 4] })?.toJSON().data, [3, 4]);
  assert.deepEqual(fromWire({ 0: 5, 1: 6 })?.toJSON().data, [5, 6]);
});

test('album hover: counts by type and culling state, ignoring sidecars of photos that are gone', async () => {
  const { albumStats } = await import('../core/albumStats');
  const culling = new Map([
    ['a.ARW', { rating: 5, flag: 'pick', edited: true, auto: {} }],
    ['b.jpg', { rating: 2, flag: 'reject', edited: false }],
    ['c.jpg', { rating: 0, edited: true }],
    ['gone.jpg', { rating: 5, flag: 'pick', edited: false }],
  ]);
  const s = albumStats(['a.ARW', 'b.jpg', 'c.jpg', 'd.png'], culling);
  assert.deepEqual(s, { photos: 4, raw: 1, jpeg: 2, other: 1, picks: 1, rejects: 1, toCull: 2, rated: 2, edited: 2, autoRanked: 1 });
});
