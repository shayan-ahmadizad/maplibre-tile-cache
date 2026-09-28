import { describe, expect, test } from 'vitest';
import type { LruEntry } from '../types';
import { resolveLimits, selectKeysToEvict } from './lruPolicy';

const entry = (key: string, lastAccess: number): LruEntry => ({ key, lastAccess });

describe('selectKeysToEvict', () => {
  test('drops the least recently used keys until under the entry cap', () => {
    const oldestFirst = [entry('a', 1), entry('b', 2), entry('c', 3)];

    expect(selectKeysToEvict(oldestFirst, 3, { maxEntries: 2 })).toEqual(['a']);
  });

  test('never evicts the key that was just written', () => {
    const oldestFirst = [entry('fresh', 1), entry('old', 0)];

    expect(selectKeysToEvict(oldestFirst, 2, { maxEntries: 1 }, { retainKey: 'fresh' })).toEqual(['old']);
  });

  test('deletes extra keys when deleteAtLeast is set', () => {
    const oldestFirst = [entry('a', 1), entry('b', 2), entry('c', 3)];

    expect(selectKeysToEvict(oldestFirst, 3, { maxEntries: 10 }, { deleteAtLeast: 2 })).toEqual(['a', 'b']);
  });
});

describe('resolveLimits', () => {
  test('fills missing values from the defaults', () => {
    expect(resolveLimits({ maxEntries: 5 }, { maxEntries: 1, maxAgeMs: 100 })).toEqual({
      maxEntries: 5,
      maxAgeMs: 100,
    });
  });
});
