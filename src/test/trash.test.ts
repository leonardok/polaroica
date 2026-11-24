import assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { DeleteItem, mergePlans, planPhotoDelete, planRejectDelete, planRejectDeleteAmong, runDeletes } from '../core/trash';

test('delete rejects: only rejected photos still on disk, each with its sidecar', () => {
  const folder = path.join('/Volumes', 'photos', '12 Natal');
  const photos = [
    { name: '_A732887.jpg', size: 100 },
    { name: '_A732888.jpg', size: 200 },
    { name: '_A732889.jpg', size: 300 },
    { name: '_A732890.jpg', size: 400 },
  ];
  const culling = new Map<string, { flag?: string }>([
    ['_A732887.jpg', { flag: 'reject' }],
    ['_A732888.jpg', { flag: 'reject' }],
    ['_A732889.jpg', {}], // kept, unflagged
    ['_A732890.jpg', { flag: 'pick' }],
    ['_A732800.jpg', { flag: 'reject' }], // sidecar left behind by a photo that's gone
  ]);
  const plan = planRejectDelete(folder, photos, culling);
  assert.deepEqual(plan.items.map((i) => i.name), ['_A732887.jpg', '_A732888.jpg']);
  assert.equal(plan.bytes, 300);
  assert.equal(plan.items[0].photo, path.join(folder, '_A732887.jpg'));
  assert.equal(plan.items[0].sidecar, path.join(folder, '.sidecar', '_A732887.jpg.xmp'));

  assert.equal(planRejectDelete(folder, photos, new Map()).items.length, 0);
});

test('delete a selection: each photo keeps the sidecar of its own folder', () => {
  const natal = path.join('/Volumes', 'photos', '12 Natal');
  const porto = path.join('/Volumes', 'photos', '13 Porto');
  const plan = planPhotoDelete([
    { path: path.join(natal, '_A732887.jpg'), size: 100 },
    { path: path.join(natal, '_A732888.arw'), size: 200 },
    { path: path.join(porto, '_A732999.jpg'), size: 300 },
  ]);
  assert.deepEqual(plan.items.map((i) => i.name), ['_A732887.jpg', '_A732888.arw', '_A732999.jpg']);
  assert.equal(plan.bytes, 600);
  assert.equal(plan.items[1].sidecar, path.join(natal, '.sidecar', '_A732888.arw.xmp'));
  assert.equal(plan.items[2].sidecar, path.join(porto, '.sidecar', '_A732999.jpg.xmp'));
});

function fakeItems(n: number): DeleteItem[] {
  return planPhotoDelete(
    Array.from({ length: n }, (_, i) => ({ path: path.join('/Volumes', 'photos', `_A${1000 + i}.jpg`), size: 1 })),
  ).items;
}

const nothing = {
  isGone: () => false,
  askPermanent: async () => false,
  progress: () => undefined,
  cancelled: () => false,
};

test('runDeletes: deletes everything, several at a time', async () => {
  const items = fakeItems(50);
  let inFlight = 0;
  let peak = 0;
  const seen: string[] = [];
  const done: number[] = [];
  const out = await runDeletes(items, {
    ...nothing,
    concurrency: 8,
    async delete(item) {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(item.name);
      inFlight--;
    },
    progress: (n) => done.push(n),
  });
  assert.deepEqual(out, { trashed: 50, removed: 0, failed: [] });
  assert.deepEqual(seen.slice().sort(), items.map((i) => i.name).sort());
  assert.equal(peak, 8);
  assert.deepEqual(done, Array.from({ length: 50 }, (_, i) => i + 1));
});

test('runDeletes: one photo at a time when asked to', async () => {
  let peak = 0;
  let inFlight = 0;
  await runDeletes(fakeItems(5), {
    ...nothing,
    concurrency: 1,
    async delete() {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
    },
  });
  assert.equal(peak, 1);
});

test('runDeletes: a volume with no Trash is asked once, then the rest go permanently', async () => {
  const items = fakeItems(20);
  let asked = 0;
  const out = await runDeletes(items, {
    ...nothing,
    concurrency: 4,
    async delete(_item, useTrash) {
      await new Promise((r) => setTimeout(r, 1));
      if (useTrash) {
        throw new Error('no Trash on this volume');
      }
    },
    askPermanent: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 1);
  assert.equal(out.trashed, 0);
  assert.equal(out.removed, 20, 'every photo, including the ones that first failed');
  assert.deepEqual(out.failed, []);
});

test('runDeletes: saying no to a permanent delete stops the run', async () => {
  const out = await runDeletes(fakeItems(20), {
    ...nothing,
    concurrency: 4,
    async delete() {
      await new Promise((r) => setTimeout(r, 1));
      throw new Error('no Trash on this volume');
    },
    askPermanent: async () => false,
  });
  assert.equal(out.trashed, 0);
  assert.equal(out.removed, 0);
  assert.ok(out.failed.length < 20, 'it stopped rather than trying them all');
});

test('runDeletes: a photo already gone is not a reason to ask, and a real failure is reported', async () => {
  const items = fakeItems(4);
  let asked = 0;
  const out = await runDeletes(items, {
    ...nothing,
    concurrency: 2,
    async delete(item) {
      if (item.name === items[1].name) {
        throw new Error('vanished');
      }
    },
    isGone: (err) => err instanceof Error && err.message === 'vanished',
    askPermanent: async () => {
      asked++;
      return true;
    },
  });
  assert.equal(asked, 0);
  assert.equal(out.trashed, 3);
  assert.deepEqual(out.failed, [`${items[1].name}: vanished`]);
});

test('runDeletes: cancelling leaves the rest alone', async () => {
  let deleted = 0;
  const out = await runDeletes(fakeItems(100), {
    ...nothing,
    concurrency: 2,
    async delete() {
      await new Promise((r) => setTimeout(r, 1));
      deleted++;
    },
    cancelled: () => deleted >= 10,
  });
  assert.ok(out.trashed >= 10 && out.trashed < 100, `stopped early, got ${out.trashed}`);
});

test('a tag album: the rejects among its own photos, folder by folder', () => {
  const natal = path.join('/Volumes', 'photos', '12 Natal');
  const porto = path.join('/Volumes', 'photos', '13 Porto');
  const culling = new Map<string, ReadonlyMap<string, { flag?: string }>>([
    [
      natal,
      new Map([
        ['_A732887.jpg', { flag: 'reject' }],
        ['_A732888.jpg', { flag: 'pick' }],
        // In the folder and rejected, but not in the album: not ours to delete.
        ['_A732999.jpg', { flag: 'reject' }],
      ]),
    ],
    [porto, new Map([['_B100001.arw', { flag: 'reject' }], ['_B100002.arw', {}]])],
  ]);

  const plan = planRejectDeleteAmong(
    [
      { path: path.join(natal, '_A732887.jpg'), size: 100 },
      { path: path.join(natal, '_A732888.jpg'), size: 200 },
      { path: path.join(porto, '_B100001.arw'), size: 300 },
      { path: path.join(porto, '_B100002.arw'), size: 400 },
    ],
    (f) => culling.get(f) ?? new Map(),
  );

  assert.deepEqual(plan.items.map((i) => i.name), ['_A732887.jpg', '_B100001.arw']);
  assert.equal(plan.bytes, 400);
  assert.equal(plan.items[0].sidecar, path.join(natal, '.sidecar', '_A732887.jpg.xmp'));
  assert.equal(plan.items[1].sidecar, path.join(porto, '.sidecar', '_B100001.arw.xmp'));
});

test('a tag album with nothing rejected, and one with no photos at all', () => {
  const natal = path.join('/Volumes', 'photos', '12 Natal');
  const none = planRejectDeleteAmong([{ path: path.join(natal, 'a.jpg'), size: 1 }], () => new Map());
  assert.deepEqual(none, { items: [], bytes: 0 });
  assert.deepEqual(planRejectDeleteAmong([], () => new Map()), { items: [], bytes: 0 });
});

test('mergePlans adds the bytes up and keeps the order it was given', () => {
  const a = planPhotoDelete([{ path: '/a/one.jpg', size: 10 }]);
  const b = planPhotoDelete([{ path: '/b/two.jpg', size: 20 }, { path: '/b/three.jpg', size: 30 }]);
  const merged = mergePlans([a, b]);
  assert.deepEqual(merged.items.map((i) => i.name), ['one.jpg', 'two.jpg', 'three.jpg']);
  assert.equal(merged.bytes, 60);
  assert.deepEqual(mergePlans([]), { items: [], bytes: 0 });
});
