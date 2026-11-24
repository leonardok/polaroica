import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { CacheManager } from '../core/cache';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polaroica-cache-'));
/** A stand-in thumbnail: a real WebP header (the cache checks for one) over filler bytes. */
const thumb = (n: number, len = 100) => {
  const data = Buffer.alloc(len, n);
  data.write('RIFF', 0, 'ascii');
  data.write('WEBP', 8, 'ascii');
  return { data, w: 4, h: 3 };
};
/** The filler, past the header the helper writes. */
const filler = (b: Buffer | undefined) => b?.[12];
const allFiller = (b: Buffer | undefined, n: number) => !!b && b.subarray(12).every((x) => x === n);

test('thumbnails round-trip, keyed by size and mtime, and survive a restart', async () => {
  const dir = tmp();
  const cm = new CacheManager(dir, 1e9);
  const fc = await cm.folder('/photos/2025');
  await fc.putThumb('a.jpg', 10, 1000, 256, thumb(1));
  await fc.putThumb('b.jpg', 20, 2000, 256, thumb(2, 50));
  let got = await fc.getThumbs([{ name: 'a.jpg', size: 10, mtime: 1000 }, { name: 'b.jpg', size: 20, mtime: 2000 }], 256);
  assert.equal(filler(got.get('a.jpg')?.data), 1);
  assert.equal(got.get('b.jpg')?.data.length, 50);
  // Edited photo (new mtime) or other thumbnail size: miss.
  assert.equal((await fc.getThumbs([{ name: 'a.jpg', size: 10, mtime: 1001 }], 256)).size, 0);
  assert.equal((await fc.getThumbs([{ name: 'a.jpg', size: 10, mtime: 1000 }], 320)).size, 0);
  fc.setListing({ folders: ['x'], photos: [{ name: 'a.jpg', size: 10, mtime: 1000 }, { name: 'b.jpg', size: 20, mtime: 2000 }], scannedAt: 1 });
  fc.setExif('a.jpg', 10, 1000, { iso: 200 });
  await fc.flush();

  const again = await new CacheManager(dir, 1e9).folder('/photos/2025');
  assert.deepEqual(again.listing?.folders, ['x']);
  assert.equal(again.getExif('a.jpg', 10, 1000)?.iso, 200);
  got = await again.getThumbs([{ name: 'b.jpg', size: 20, mtime: 2000 }], 256);
  assert.equal(filler(got.get('b.jpg')?.data), 2);
});

test('listing drops thumbnails of removed photos; compaction reclaims space', async () => {
  const cm = new CacheManager(tmp(), 1e9);
  const fc = await cm.folder('/p');
  for (let i = 0; i < 10; i++) {
    await fc.putThumb(`${i}.jpg`, i, i, 256, thumb(i, 100 * 1024));
  }
  fc.setListing({ folders: [], photos: [{ name: '9.jpg', size: 9, mtime: 9 }], scannedAt: 1 });
  assert.equal(fc.thumbCount, 1);
  await fc.compactIfNeeded();
  assert.equal(fc.bytes, 100 * 1024);
  const got = await fc.getThumbs([{ name: '9.jpg', size: 9, mtime: 9 }], 256);
  assert.equal(filler(got.get('9.jpg')?.data), 9);
});

test('moveThumb carries a thumbnail to another folder', async () => {
  const cm = new CacheManager(tmp(), 1e9);
  await (await cm.folder('/a')).putThumb('x.jpg', 1, 1, 256, thumb(7));
  await cm.moveThumb({ folder: '/a', name: 'x.jpg', size: 1, mtime: 1 }, { folder: '/b', name: 'x (1).jpg', size: 1, mtime: 5 }, 256);
  assert.equal((await (await cm.folder('/a')).getThumbs([{ name: 'x.jpg', size: 1, mtime: 1 }], 256)).size, 0);
  const got = await (await cm.folder('/b')).getThumbs([{ name: 'x (1).jpg', size: 1, mtime: 5 }], 256);
  assert.equal(filler(got.get('x (1).jpg')?.data), 7);
});

test('eviction removes least recently used folders first', async () => {
  const dir = tmp();
  const cm = new CacheManager(dir, 250 * 1024);
  for (const [i, name] of ['/old', '/mid', '/new'].entries()) {
    const fc = await cm.folder(name);
    await fc.putThumb('a.jpg', 1, 1, 256, thumb(i, 100 * 1024));
    await fc.flush();
    const t = new Date(Date.now() - (3 - i) * 60000);
    fs.utimesSync(path.join(fc.dir, 'index.json'), t, t);
  }
  const removed = await cm.evict();
  assert.equal(removed, 1);
  assert.equal((await new CacheManager(dir, 1e9).folder('/old')).thumbCount, 0);
  assert.equal((await new CacheManager(dir, 1e9).folder('/new')).thumbCount, 1);
});

test('thumbnails written after the last index save do not shift later ones (quit before save)', async () => {
  const dir = tmp();
  // First run: thumbnails appended, the app quits before the index is ever saved.
  const first = await new CacheManager(dir, 1e9).folder('/q');
  await first.putThumb('a.jpg', 1, 1, 256, thumb(1, 300));
  await first.putThumb('b.jpg', 2, 2, 256, thumb(2, 200));

  // Second run: no index on disk, but the pack has 500 bytes in it.
  const second = await new CacheManager(dir, 1e9).folder('/q');
  await second.putThumb('c.jpg', 3, 3, 256, thumb(3, 100));
  let got = await second.getThumbs([{ name: 'c.jpg', size: 3, mtime: 3 }], 256);
  assert.equal(allFiller(got.get('c.jpg')?.data, 3), true);
  await second.flush();

  // Third run: the index is saved, then another thumbnail goes in before the next save.
  await second.putThumb('d.jpg', 4, 4, 256, thumb(4, 100));
  const third = await new CacheManager(dir, 1e9).folder('/q');
  await third.putThumb('e.jpg', 5, 5, 256, thumb(5, 100));
  got = await third.getThumbs([{ name: 'c.jpg', size: 3, mtime: 3 }, { name: 'e.jpg', size: 5, mtime: 5 }], 256);
  assert.equal(allFiller(got.get('c.jpg')?.data, 3), true);
  assert.equal(allFiller(got.get('e.jpg')?.data, 5), true);
  // Settle pending index saves one at a time (all three runs share one folder here).
  for (const fc of [first, second, third]) await fc.flush();
});

test('a cached thumbnail that is no longer a thumbnail is dropped, not served', async () => {
  const dir = tmp();
  const cm = new CacheManager(dir, 1e9);
  const fc = await cm.folder('/photos/2025');
  await fc.putThumb('good.jpg', 1, 1, 256, thumb(1, 200));
  await fc.putThumb('bad.jpg', 2, 2, 256, thumb(2, 200));
  await fc.flush();

  // What a pack and an index that drifted apart leave behind: the entry still looks fresh (same
  // size and mtime) but the bytes it points at are not a thumbnail any more.
  const pack = path.join(dir, fs.readdirSync(dir).find((d) => fs.existsSync(path.join(dir, d, 'thumbs.bin')))!, 'thumbs.bin');
  const bytes = fs.readFileSync(pack);
  bytes.fill(0, 200, 400); // the second thumbnail, zeroed
  fs.writeFileSync(pack, bytes);

  const again = await new CacheManager(dir, 1e9).folder('/photos/2025');
  const got = await again.getThumbs(
    [{ name: 'good.jpg', size: 1, mtime: 1 }, { name: 'bad.jpg', size: 2, mtime: 2 }],
    256,
  );
  assert.equal(filler(got.get('good.jpg')?.data), 1, 'the sound one is still served');
  assert.equal(got.has('bad.jpg'), false, 'the broken one is not served as a broken image');
  assert.equal(again.hasThumb('bad.jpg', 2, 2, 256), false, 'and it is forgotten, so it gets made again');
});

test('compaction forgets an unreadable entry instead of freezing zeros into the pack', async () => {
  const dir = tmp();
  const cm = new CacheManager(dir, 1e9);
  const fc = await cm.folder('/photos/2025');
  // Enough garbage to make compaction worthwhile, and one entry pointing past the end of the pack.
  await fc.putThumb('keep.jpg', 1, 1, 256, thumb(1, 400 * 1024));
  await fc.putThumb('keep.jpg', 1, 1, 256, thumb(2, 400 * 1024)); // replaces it: the old one is garbage
  await fc.putThumb('stale.jpg', 3, 3, 256, thumb(3, 300));
  const pack = path.join(dir, fs.readdirSync(dir).find((d) => fs.existsSync(path.join(dir, d, 'thumbs.bin')))!, 'thumbs.bin');
  fs.truncateSync(pack, fs.statSync(pack).size - 300); // stale.jpg's bytes are gone

  await fc.compactIfNeeded();
  await fc.flush();

  const again = await new CacheManager(dir, 1e9).folder('/photos/2025');
  assert.equal(again.hasThumb('stale.jpg', 3, 3, 256), false, 'forgotten, so the photo gets a real thumbnail again');
  const got = await again.getThumbs([{ name: 'keep.jpg', size: 1, mtime: 1 }], 256);
  assert.equal(allFiller(got.get('keep.jpg')?.data, 2), true, 'the live thumbnail came through compaction intact');
});
