import { DEFAULT_LIMITS } from '../constants';
import type { CacheLimits, LruEntry } from '../types';

export const resolveLimits = (limits?: Partial<CacheLimits>, defaults: CacheLimits = DEFAULT_LIMITS): CacheLimits => ({
  maxEntries: limits?.maxEntries ?? defaults.maxEntries,
  maxAgeMs: limits?.maxAgeMs ?? defaults.maxAgeMs,
});

/**
 * Picks least recently used keys until the entry count is within `maxEntries`.
 * `retainKey` is never evicted, since that is the entry being written.
 * `deleteAtLeast` forces extra evictions, used to make room after a quota error.
 */
export const selectKeysToEvict = (
  oldestFirst: readonly LruEntry[],
  count: number,
  limits: Pick<CacheLimits, 'maxEntries'>,
  options?: { retainKey?: string; deleteAtLeast?: number },
): string[] => {
  const retainKey = options?.retainKey;
  const deleteAtLeast = options?.deleteAtLeast ?? 0;
  const keys: string[] = [];
  let remaining = count;

  for (const entry of oldestFirst) {
    if (entry.key === retainKey) {
      continue;
    }
    if (remaining <= limits.maxEntries && keys.length >= deleteAtLeast) {
      break;
    }
    keys.push(entry.key);
    remaining = Math.max(0, remaining - 1);
  }

  return keys;
};
