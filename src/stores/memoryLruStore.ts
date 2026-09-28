import type { CacheLimits, LruEntry, TileStore } from '../types';
import { resolveLimits, selectKeysToEvict } from './lruPolicy';

type MemoryRecord = LruEntry & {
  data: ArrayBuffer;
};

export type MemoryLruStoreOptions = {
  limits?: Partial<CacheLimits>;
  now?: () => number;
};

export type MemoryLruStore = Required<TileStore> & {
  /** Snapshot of the current contents, handy in tests. */
  readonly records: Map<string, ArrayBuffer>;
};

/**
 * In-process store with the same LRU rules as the IndexedDB one. Useful for
 * tests, SSR, or environments where IndexedDB is unavailable. Nothing survives
 * a reload.
 */
export const createMemoryLruStore = (options?: MemoryLruStoreOptions): MemoryLruStore => {
  const limits = resolveLimits(options?.limits);
  const now = options?.now ?? Date.now;
  const entries = new Map<string, MemoryRecord>();

  const evict = (retainKey?: string) => {
    const oldestFirst = [...entries.values()].sort((a, b) => a.lastAccess - b.lastAccess);
    const keys = selectKeysToEvict(oldestFirst, entries.size, limits, { retainKey });
    keys.forEach((key) => entries.delete(key));
  };

  return {
    get records() {
      const snapshot = new Map<string, ArrayBuffer>();
      entries.forEach((entry, key) => snapshot.set(key, entry.data));
      return snapshot;
    },

    async get(key) {
      const record = entries.get(key);
      if (!record) {
        return undefined;
      }
      if (now() - record.lastAccess > limits.maxAgeMs) {
        entries.delete(key);
        return undefined;
      }
      record.lastAccess = now();
      return record.data;
    },

    async put(key, data) {
      entries.set(key, { key, data, lastAccess: now() });
      evict(key);
    },

    async clear() {
      entries.clear();
    },
  };
};
