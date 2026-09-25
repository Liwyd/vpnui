import test from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from '../../backend/lib/mutex.js';

test('serializes critical sections', async () => {
  const mutex = new Mutex('test');
  const events = [];
  const job = (id, delay) =>
    mutex.run(async () => {
      events.push(`start:${id}`);
      await new Promise((r) => setTimeout(r, delay));
      events.push(`end:${id}`);
    });

  await Promise.all([job('a', 30), job('b', 10), job('c', 5)]);
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
});

test('releases the lock when a job throws', async () => {
  const mutex = new Mutex('test');
  await assert.rejects(mutex.run(() => Promise.reject(new Error('boom'))), /boom/);
  const result = await mutex.run(() => Promise.resolve('still-works'));
  assert.equal(result, 'still-works');
});
