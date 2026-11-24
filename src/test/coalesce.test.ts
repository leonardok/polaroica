import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Coalescer, Timers } from '../core/coalesce';

/** A clock we drive by hand, so the tests say what they mean about bursts. */
function fakeTimers(): Timers & { tick(): void; pending(): number } {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    set(fn) {
      const h = next++;
      queue.set(h, fn);
      return h;
    },
    clear(h) {
      queue.delete(h as number);
    },
    tick() {
      const due = [...queue.entries()];
      queue.clear();
      for (const [, fn] of due) fn();
    },
    pending: () => queue.size,
  };
}

test('a burst of folder changes is reported once', () => {
  const timers = fakeTimers();
  const fired: Array<{ keys: string[]; all: boolean }> = [];
  const c = new Coalescer<string>((keys, all) => fired.push({ keys: [...keys].sort(), all }), 120, timers);

  for (let i = 0; i < 600; i++) {
    c.add('/photos/natal');
    c.add('/photos/natal/.sidecar');
  }
  assert.deepEqual(fired, [], 'nothing until the burst is over');
  timers.tick();
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0], { keys: ['/photos/natal', '/photos/natal/.sidecar'], all: false });

  timers.tick();
  assert.equal(fired.length, 1, 'nothing more once it has been reported');
});

test('"everything changed" outranks the folders collected with it', () => {
  const timers = fakeTimers();
  const fired: Array<{ keys: string[]; all: boolean }> = [];
  const c = new Coalescer<string>((keys, all) => fired.push({ keys: [...keys], all }), 120, timers);
  c.add('/photos/natal');
  c.add(undefined);
  c.add('/photos/porto');
  timers.tick();
  assert.deepEqual(fired, [{ keys: [], all: true }]);
});

test('a hold reports nothing until it is released, and then just once', () => {
  const timers = fakeTimers();
  let fired = 0;
  const c = new Coalescer<string>(() => fired++, 120, timers);

  const release = c.hold();
  for (let i = 0; i < 300; i++) {
    c.add('/photos/natal');
  }
  timers.tick();
  assert.equal(fired, 0, 'held: a bulk delete does not refresh while it works');
  assert.equal(timers.pending(), 0, 'and no timer is left armed');

  release();
  timers.tick();
  assert.equal(fired, 1);
});

test('holds nest: the last one out arms the refresh', () => {
  const timers = fakeTimers();
  let fired = 0;
  const c = new Coalescer<string>(() => fired++, 120, timers);
  const a = c.hold();
  const b = c.hold();
  c.add('/photos/natal');
  a();
  timers.tick();
  assert.equal(fired, 0, 'still held by the second');
  b();
  timers.tick();
  assert.equal(fired, 1);
  a();
  b();
  timers.tick();
  assert.equal(fired, 1, 'releasing twice does not re-fire or go negative');
});

test('a hold with nothing collected reports nothing', () => {
  const timers = fakeTimers();
  let fired = 0;
  const c = new Coalescer<string>(() => fired++, 120, timers);
  c.hold()();
  timers.tick();
  assert.equal(fired, 0);
});

test('flushNow reports what has piled up without waiting', () => {
  const timers = fakeTimers();
  const fired: string[][] = [];
  const c = new Coalescer<string>((keys) => fired.push([...keys]), 120, timers);
  c.add('/photos/natal');
  c.flushNow();
  assert.deepEqual(fired, [['/photos/natal']]);
  timers.tick();
  assert.equal(fired.length, 1, 'the armed timer was cancelled, not left to fire again');
});
