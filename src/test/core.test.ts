import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cameraLabel, formatExifDate, formatExposure, readExif } from '../core/exif';
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
