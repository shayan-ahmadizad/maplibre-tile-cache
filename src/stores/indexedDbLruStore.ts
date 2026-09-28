import { DB_VERSION, DEFAULT_DB_NAME } from '../constants';
import type { CacheLimits, TileStore } from '../types';
import { isQuotaError, requestToPromise, waitForTransaction } from './idb';
import { resolveLimits } from './lruPolicy';

const TILES_STORE = 'tiles';
const LAST_ACCESS_INDEX = 'lastAccess';

/** Share of `maxEntries` dropped when the browser reports the origin is out of quota. */
const QUOTA_EVICTION_RATIO = 0.1;

type TileRecord = {
  key: string;
  data: ArrayBuffer;
  lastAccess: number;
};

export type IndexedDbLruStoreOptions = {
  /** @default 'maplibre-tile-cache' */
  dbName?: string;
  limits?: Partial<CacheLimits>;
  now?: () => number;
};

const openDatabase = (dbName: string): Promise<IDBDatabase | null> => {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(TILES_STORE)) {
          const tiles = db.createObjectStore(TILES_STORE, { keyPath: 'key' });
          tiles.createIndex(LAST_ACCESS_INDEX, LAST_ACCESS_INDEX);
        }
      };
      request.onsuccess = () => resolve(request.result);
      // Private mode in some browsers, blocked storage, etc. The map keeps working off the network.
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
};

/**
 * IndexedDB LRU store: one object store of `{ key, data, lastAccess }` with an
 * index on `lastAccess`.
 *
 * Keeping it cheap on the hot path:
 * - Keys are mirrored in a `Set`, so a miss never touches IndexedDB.
 * - Eviction walks a key cursor on `lastAccess`, so tile bytes are never read
 *   into JS just to be deleted.
 * - `lastAccess` is refreshed at most once per key per page session. That makes
 *   the LRU approximate within a session, but a tile isn't rewritten every time
 *   the map pans over it.
 * - All writes go through one queue, so the entry count used for eviction
 *   can't race.
 */
export const createIndexedDbLruStore = (options?: IndexedDbLruStoreOptions): Required<TileStore> => {
  const limits = resolveLimits(options?.limits);
  const now = options?.now ?? Date.now;
  const dbName = options?.dbName ?? DEFAULT_DB_NAME;

  let dbPromise: Promise<IDBDatabase | null> | null = null;
  let writeChain = Promise.resolve();
  let knownKeys: Set<string> | null = null;
  const touchedThisSession = new Set<string>();

  const getDb = () => {
    if (!dbPromise) {
      dbPromise = openDatabase(dbName).then((db) => {
        if (db) {
          // Let a newer version of the library (in another tab) upgrade the schema.
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
            knownKeys = null;
          };
        }
        return db;
      });
    }
    return dbPromise;
  };

  const enqueueWrite = (task: () => Promise<void>) => {
    const run = writeChain.then(task, task);
    writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const forgetKey = (key: string) => {
    knownKeys?.delete(key);
    touchedThisSession.delete(key);
  };

  const ensureKeyIndex = async (db: IDBDatabase) => {
    if (knownKeys) {
      return;
    }
    const keys = await requestToPromise(db.transaction(TILES_STORE, 'readonly').objectStore(TILES_STORE).getAllKeys());
    knownKeys = new Set(keys.map(String));
  };

  const evictOldest = (tx: IDBTransaction, retainKey: string, deleteCount: number) => {
    const store = tx.objectStore(TILES_STORE);
    const index = store.index(LAST_ACCESS_INDEX);
    let remaining = deleteCount;

    return new Promise<void>((resolve, reject) => {
      const cursorRequest = index.openKeyCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || remaining <= 0) {
          resolve();
          return;
        }
        const key = String(cursor.primaryKey);
        if (key !== retainKey) {
          store.delete(key);
          forgetKey(key);
          remaining -= 1;
        }
        cursor.continue();
      };
    });
  };

  const putRecord = async (db: IDBDatabase, record: TileRecord, deleteAtLeast = 0) => {
    await ensureKeyIndex(db);
    const tx = db.transaction(TILES_STORE, 'readwrite');
    const done = waitForTransaction(tx);
    tx.objectStore(TILES_STORE).put(record);
    knownKeys?.add(record.key);
    touchedThisSession.add(record.key);

    const overLimit = Math.max(0, (knownKeys?.size ?? 0) - limits.maxEntries);
    const deleteCount = Math.max(overLimit, deleteAtLeast);
    if (deleteCount > 0) {
      await evictOldest(tx, record.key, deleteCount);
    }
    await done;
  };

  const deleteKey = async (db: IDBDatabase, key: string) => {
    const tx = db.transaction(TILES_STORE, 'readwrite');
    const done = waitForTransaction(tx);
    tx.objectStore(TILES_STORE).delete(key);
    forgetKey(key);
    await done;
  };

  const touch = (db: IDBDatabase, record: TileRecord) => {
    if (touchedThisSession.has(record.key)) {
      return;
    }
    touchedThisSession.add(record.key);
    void enqueueWrite(async () => {
      const tx = db.transaction(TILES_STORE, 'readwrite');
      tx.objectStore(TILES_STORE).put({ ...record, lastAccess: now() });
      await waitForTransaction(tx);
    }).catch(() => undefined);
  };

  // Warm the key index early so the first map requests can skip IndexedDB on a miss.
  void getDb()
    .then((db) => (db ? ensureKeyIndex(db) : undefined))
    .catch(() => undefined);

  return {
    async get(key) {
      const db = await getDb();
      if (!db) {
        return undefined;
      }

      await ensureKeyIndex(db);
      if (knownKeys && !knownKeys.has(key)) {
        return undefined;
      }

      const tx = db.transaction(TILES_STORE, 'readonly');
      const record = (await requestToPromise(tx.objectStore(TILES_STORE).get(key))) as TileRecord | undefined;
      if (!record) {
        forgetKey(key);
        return undefined;
      }
      if (now() - record.lastAccess > limits.maxAgeMs) {
        await enqueueWrite(() => deleteKey(db, key)).catch(() => undefined);
        return undefined;
      }

      touch(db, record);
      return record.data;
    },

    async put(key, data) {
      const db = await getDb();
      if (!db) {
        return;
      }

      const record: TileRecord = { key, data, lastAccess: now() };

      await enqueueWrite(async () => {
        try {
          await putRecord(db, record);
        } catch (error) {
          if (!isQuotaError(error)) {
            return;
          }
          try {
            await putRecord(db, record, Math.ceil(limits.maxEntries * QUOTA_EVICTION_RATIO));
          } catch {
            // Still out of space. The tile was served from the network, so just skip caching it.
          }
        }
      });
    },

    async clear() {
      const db = await getDb();
      if (!db) {
        return;
      }
      await enqueueWrite(async () => {
        const tx = db.transaction(TILES_STORE, 'readwrite');
        tx.objectStore(TILES_STORE).clear();
        await waitForTransaction(tx);
        knownKeys = new Set();
        touchedThisSession.clear();
      });
    },
  };
};
