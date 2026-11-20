// The debounced project write in src/lib/projectSaveQueue.ts. The rule these
// pin down: a waiting write is only ever replaced by a newer write of the same
// project. A write of another project, or another project going onto the
// canvas, writes it first, because those are the last edits of the project
// being left, and the editor already showed them as done.

import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSaveQueue, PROJECT_SAVE_DELAY_MS, type ProjectSave } from '@/lib/projectSaveQueue';
import type { ArtboardState } from '@/types/artboard';

/** A save of `id` whose one artboard holds `elements` elements. */
function save(id: string, elements: number): ProjectSave {
  const board = { id: `ab_${id}`, elements: Array.from({ length: elements }, (_, i) => ({ id: `el_${i}` })) };
  return { id, name: `Project ${id}`, artboards: [board as unknown as ArtboardState] };
}

/** The writes so far, as `<id>:<element count>`. */
function recorder() {
  const written: string[] = [];
  const queue = createProjectSaveQueue(async (row) => {
    written.push(`${row.id}:${row.artboards[0].elements.length}`);
  });
  return { written, queue };
}

beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
afterEach(() => mock.timers.reset());

test('a save is written once the edits go quiet, and a newer save of the same project replaces it', () => {
  const { written, queue } = recorder();
  queue.schedule(save('a', 1));
  mock.timers.tick(PROJECT_SAVE_DELAY_MS - 100);
  queue.schedule(save('a', 2));
  mock.timers.tick(PROJECT_SAVE_DELAY_MS - 1);
  assert.deepEqual(written, []);
  mock.timers.tick(1);
  assert.deepEqual(written, ['a:2']);
  mock.timers.tick(PROJECT_SAVE_DELAY_MS * 2);
  assert.deepEqual(written, ['a:2']);
});

test('a save of another project writes the one waiting first', () => {
  const { written, queue } = recorder();
  queue.schedule(save('a', 4));
  // The project opened next is edited before the first one's delay is up.
  queue.schedule(save('b', 1));
  assert.deepEqual(written, ['a:4']);
  mock.timers.tick(PROJECT_SAVE_DELAY_MS);
  assert.deepEqual(written, ['a:4', 'b:1']);
});

test('another project going onto the canvas writes the save waiting for the one before', () => {
  const { written, queue } = recorder();
  queue.schedule(save('a', 4));
  void queue.flushOtherThan('a');
  assert.deepEqual(written, [], 'the same project stays on the canvas, so its save keeps waiting');
  void queue.flushOtherThan('b');
  assert.deepEqual(written, ['a:4']);
  mock.timers.tick(PROJECT_SAVE_DELAY_MS * 2);
  assert.deepEqual(written, ['a:4'], 'written once, and the timer is gone');
});

test('drop forgets the save of that project only', () => {
  const { written, queue } = recorder();
  queue.schedule(save('a', 2));
  queue.drop('b');
  mock.timers.tick(PROJECT_SAVE_DELAY_MS);
  assert.deepEqual(written, ['a:2']);

  queue.schedule(save('a', 3));
  queue.drop('a');
  mock.timers.tick(PROJECT_SAVE_DELAY_MS * 2);
  assert.deepEqual(written, ['a:2']);
});

test('a flush waits for a write the timer already started', async () => {
  const written: string[] = [];
  let land = () => {};
  const queue = createProjectSaveQueue(
    (row) =>
      new Promise<void>((resolve) => {
        land = () => {
          written.push(row.id);
          resolve();
        };
      })
  );
  queue.schedule(save('a', 1));
  mock.timers.tick(PROJECT_SAVE_DELAY_MS);
  // Nothing waits any more, but the write is still under way. A window lets go
  // of the project after a flush, so the flush has to wait for it.
  let flushed = false;
  const flushing = queue.flush().then(() => {
    flushed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flushed, false);
  land();
  await flushing;
  assert.deepEqual(written, ['a']);
});

test('flush writes the waiting save at once, and only once', async () => {
  const { written, queue } = recorder();
  await queue.flush();
  assert.deepEqual(written, []);
  queue.schedule(save('a', 5));
  await queue.flush();
  assert.deepEqual(written, ['a:5']);
  await queue.flush();
  mock.timers.tick(PROJECT_SAVE_DELAY_MS * 2);
  assert.deepEqual(written, ['a:5']);
});

test('a rejected save stays recoverable and flush rejects until retry succeeds', async () => {
  let full = true;
  const written: ProjectSave[] = [];
  const queue = createProjectSaveQueue(async (row) => {
    if (full) throw new DOMException('Storage is full', 'QuotaExceededError');
    written.push(row);
  });
  queue.schedule(save('a', 2));
  await assert.rejects(queue.flush(), { name: 'QuotaExceededError' });
  assert.equal(queue.getFailures()[0].save.artboards[0].elements.length, 2);
  assert.equal(queue.hasPending('a'), true);
  full = false;
  await queue.retry('a');
  assert.equal(written.length, 1);
  assert.equal(queue.hasPending(), false);
  assert.equal(queue.getFailures().length, 0);
});

test('a failed project keeps its latest edits while another project is saved', async () => {
  let full = true;
  const written: string[] = [];
  const queue = createProjectSaveQueue(async (row) => {
    if (row.id === 'a' && full) throw new Error('Full');
    written.push(`${row.id}:${row.artboards[0].elements.length}`);
  });
  queue.schedule(save('a', 1));
  await assert.rejects(queue.flush());
  queue.schedule(save('b', 2));
  await queue.retry('b');
  queue.schedule(save('a', 4));
  assert.equal(queue.getFailures()[0].save.artboards[0].elements.length, 4);
  full = false;
  await queue.retry('a');
  assert.deepEqual(written, ['b:2', 'a:4']);
});

test('a late successful write cannot discard a newer pending document', async () => {
  let land!: () => void;
  const written: number[] = [];
  const queue = createProjectSaveQueue((row) => {
    written.push(row.artboards[0].elements.length);
    return written.length === 1 ? new Promise<void>((resolve) => { land = resolve; }) : Promise.resolve();
  });
  queue.schedule(save('a', 1));
  const flushing = queue.flush();
  queue.schedule(save('a', 3));
  land();
  await flushing;
  assert.deepEqual(written, [1, 3]);
  assert.equal(queue.hasPending(), false);
});

test('an old failure preserves a newer document and another flush retries only the newer one', async () => {
  let refuse!: (error: Error) => void;
  const written: number[] = [];
  const queue = createProjectSaveQueue((row) => {
    written.push(row.artboards[0].elements.length);
    return written.length === 1 ? new Promise<void>((_, reject) => { refuse = reject; }) : Promise.resolve();
  });
  queue.schedule(save('a', 1));
  const flushing = queue.flush();
  queue.schedule(save('a', 5));
  refuse(new Error('Full'));
  await assert.rejects(flushing);
  assert.equal(queue.getPending('a')?.artboards[0].elements.length, 5);
  await queue.flush();
  assert.deepEqual(written, [1, 5]);
});

test('simultaneous flushes share a write and both report its failure', async () => {
  let refuse!: (error: Error) => void;
  let calls = 0;
  const queue = createProjectSaveQueue(() => {
    calls += 1;
    return new Promise<void>((_, reject) => { refuse = reject; });
  });
  queue.schedule(save('a', 1));
  const first = queue.flush();
  const second = queue.flush();
  refuse(new Error('Full'));
  await Promise.all([assert.rejects(first), assert.rejects(second)]);
  assert.equal(calls, 1);
  assert.equal(queue.getFailures().length, 1);
});
