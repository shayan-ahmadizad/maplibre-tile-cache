import { describe, expect, test } from 'vitest';
import { createMemoryLruStore } from './memoryLruStore';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

const tickingClock = (start = 100) => {
  let time = start;
  return () => ++time;
};

describe('createMemoryLruStore', () => {
  test('evicts the least recently used entry when over maxEntries', async () => {
    const store = createMemoryLruStore({ limits: { maxEntries: 2, maxAgeMs: 60_000 }, now: tickingClock() });

    await store.put('a', bytes(1));
    await store.put('b', bytes(2));
    await store.get('a');
    await store.put('c', bytes(3));

    expect([...store.records.keys()].sort()).toEqual(['a', 'c']);
  });

  test('expires entries that were not used within maxAgeMs', async () => {
    let time = 0;
    const store = createMemoryLruStore({ limits: { maxEntries: 10, maxAgeMs: 1000 }, now: () => time });

    await store.put('a', bytes(1));
    time = 1001;

    expect(await store.get('a')).toBeUndefined();
    expect(store.records.size).toBe(0);
  });

  test('clear removes everything', async () => {
    const store = createMemoryLruStore();
    await store.put('a', bytes(1));
    await store.clear();

    expect(store.records.size).toBe(0);
  });
});
