import assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { planRejectDelete } from '../core/trash';

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
