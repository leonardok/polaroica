import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TagIndex } from '../tagIndex';

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'polaroica-tags-'));
}

/** A real file, so the freshness check passes. */
function photo(dir: string, name: string): { fsPath: string; size: number; mtime: number } {
  const fsPath = path.join(dir, name);
  fs.writeFileSync(fsPath, name);
  const st = fs.statSync(fsPath);
  return { fsPath, size: st.size, mtime: Math.round(st.mtimeMs) };
}

test('tags are remembered, counted and found again', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  const b = photo(dir, 'b.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot', 'Receipts']);
  await index.set(b.fsPath, b.size, b.mtime, ['Screenshot']);

  assert.deepEqual(await index.allTags(), [
    { tag: 'Screenshot', photos: 2 },
    { tag: 'Receipts', photos: 1 },
  ]);
  assert.deepEqual((await index.photosWithTag('Screenshot')).map((p) => p.fsPath), [a.fsPath, b.fsPath]);
  // Tags are matched without regard to case.
  assert.equal((await index.photosWithTag('screenshot')).length, 2);
  assert.deepEqual(await index.tagsOf(a.fsPath), ['Screenshot', 'Receipts']);
});

test('a later record replaces an earlier one, and the tag goes when nothing has it', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot', 'Receipts']);
  await index.set(a.fsPath, a.size, a.mtime, ['Receipts']);
  assert.deepEqual(await index.tagsOf(a.fsPath), ['Receipts']);
  assert.deepEqual(await index.allTags(), [{ tag: 'Receipts', photos: 1 }]);
  await index.set(a.fsPath, a.size, a.mtime, []);
  assert.deepEqual(await index.allTags(), []);
});

test('the log survives a restart, and a torn last line is dropped', async () => {
  const dir = tmp();
  const file = path.join(dir, 'index');
  const a = photo(dir, 'a.png');
  const first = new TagIndex(file);
  await first.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  await first.flush();

  const reopened = new TagIndex(file);
  assert.deepEqual(await reopened.tagsOf(a.fsPath), ['Screenshot']);

  // Killed mid-append: half a line at the end.
  fs.appendFileSync(path.join(file, 'tags.ndjson'), '{"p":"/x","s":1,');
  const afterCrash = new TagIndex(file);
  assert.deepEqual(await afterCrash.tagsOf(a.fsPath), ['Screenshot']);
  assert.deepEqual(await afterCrash.tagsOf('/x'), []);
});

test('a photo replaced since it was tagged is dropped rather than returned', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  // Same path, different content: not the photo that was tagged.
  fs.writeFileSync(a.fsPath, 'something else entirely');
  assert.deepEqual(await index.photosWithTag('Screenshot'), []);
  assert.deepEqual(await index.allTags(), []);
});

test('a photo whose file is gone is dropped', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  fs.rmSync(a.fsPath);
  assert.deepEqual(await index.photosWithTag('Screenshot'), []);
});

test('forgetUnder drops a whole folder', async () => {
  const dir = tmp();
  const sub = path.join(dir, 'sub');
  fs.mkdirSync(sub);
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  const b = photo(sub, 'b.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  await index.set(b.fsPath, b.size, b.mtime, ['Screenshot']);
  await index.forgetUnder(sub);
  assert.deepEqual((await index.photosWithTag('Screenshot')).map((p) => p.fsPath), [a.fsPath]);
});

test('writing the same tags again does not grow the log', async () => {
  const dir = tmp();
  const file = path.join(dir, 'index');
  const index = new TagIndex(file);
  const a = photo(dir, 'a.png');
  for (let i = 0; i < 20; i++) {
    await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  }
  await index.flush();
  const lines = fs.readFileSync(path.join(file, 'tags.ndjson'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2); // the version header and one record
});

test('the log is compacted, so repeated scans do not grow it without bound', async () => {
  const dir = tmp();
  const file = path.join(dir, 'index');
  const index = new TagIndex(file);
  const a = photo(dir, 'a.png');
  // Alternating values, so every one of the 2000 writes is a real change to append.
  const writes = 2000;
  const tagFor = (i: number) => (i % 2 ? 'Screenshot' : 'Receipts');
  for (let i = 0; i < writes; i++) {
    await index.set(a.fsPath, a.size, a.mtime, [tagFor(i)]);
  }
  await index.flush();
  const lines = fs.readFileSync(path.join(file, 'tags.ndjson'), 'utf8').trim().split('\n');
  // Bounded at max(256, 2 x photos) records plus the version header — not one line per write.
  assert.ok(lines.length <= 258, `log should stay bounded, has ${lines.length} lines`);
  assert.ok(lines.length < writes / 4, `log should have been compacted, has ${lines.length} lines`);
  // And it still reads back correctly.
  const reopened = new TagIndex(file);
  assert.deepEqual(await reopened.tagsOf(a.fsPath), [tagFor(writes - 1)]);
});

test('dropping a renamed photo on read reports the change, so a stale count cannot survive it', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  const b = photo(dir, 'b.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  await index.set(b.fsPath, b.size, b.mtime, ['Screenshot']);
  assert.deepEqual(await index.allTags(), [{ tag: 'Screenshot', photos: 2 }]);

  let changes = 0;
  index.onChanged = () => changes++;
  // Renamed outside Polaroica: the path the index holds no longer exists.
  fs.renameSync(a.fsPath, path.join(dir, 'renamed.png'));

  assert.deepEqual((await index.photosWithTag('Screenshot')).map((p) => p.fsPath), [b.fsPath]);
  assert.equal(changes, 1, 'the dropped record is reported');
  assert.deepEqual(await index.allTags(), [{ tag: 'Screenshot', photos: 1 }]);
});

test('a record is kept when the file is untouched, and reports nothing', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  let changes = 0;
  index.onChanged = () => changes++;
  assert.equal((await index.photosWithTag('Screenshot')).length, 1);
  // Writing the same tags again must not grow the log or report a change.
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  assert.equal(changes, 0);
});

test('prune forgets photos that are no longer there', async () => {
  const dir = tmp();
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(dir, 'a.png');
  const b = photo(dir, 'b.png');
  const c = photo(dir, 'c.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);
  await index.set(b.fsPath, b.size, b.mtime, ['Screenshot']);
  await index.set(c.fsPath, c.size, c.mtime, ['Receipts']);

  fs.rmSync(a.fsPath); // deleted
  fs.writeFileSync(c.fsPath, 'a different picture under the same name'); // replaced

  assert.equal(await index.prune(), 2);
  assert.deepEqual(await index.allTags(), [{ tag: 'Screenshot', photos: 1 }]);
  assert.deepEqual((await index.photosWithTag('Screenshot')).map((p) => p.fsPath), [b.fsPath]);
});

test('a folder that cannot be reached keeps its records', async () => {
  const dir = tmp();
  const away = path.join(dir, 'share');
  fs.mkdirSync(away);
  const index = new TagIndex(path.join(dir, 'index'));
  const a = photo(away, 'a.png');
  await index.set(a.fsPath, a.size, a.mtime, ['Screenshot']);

  // The share went away: the photo is out of reach, not gone.
  fs.rmSync(away, { recursive: true });

  assert.equal(await index.prune(), 0, 'nothing is forgotten while the folder is unreachable');
  assert.deepEqual(await index.allTags(), [{ tag: 'Screenshot', photos: 1 }]);
  // It is still left out of the grid, which can only show photos it can read.
  assert.deepEqual(await index.photosWithTag('Screenshot'), []);
  assert.deepEqual(await index.allTags(), [{ tag: 'Screenshot', photos: 1 }], 'and the count survives');
});
