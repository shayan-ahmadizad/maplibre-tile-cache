import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'vitest';
import { createIndexedDbLruStore } from './indexedDbLruStore';

const bytes = (...values: number[]) => new Uint8Array(values).buffer;
const read = (buffer: ArrayBuffer | undefined) => (buffer ? [...new Uint8Array(buffer)] : undefined);

let dbCounter = 0;
const uniqueDbName = () => `tile-cache-test-${++dbCounter}`;

describe('createIndexedDbLruStore', () => {
  const originalIndexedDb = globalThis.indexedDB;

  afterEach(() => {
    globalThis.indexedDB = originalIndexedDb;
  });

  test('persists tiles across store instances', async () => {
    const dbName = uniqueDbName();
    await createIndexedDbLruStore({ dbName }).put('/1/0/0.pbf', bytes(1, 2, 3));

    const reopened = createIndexedDbLruStore({ dbName });

    expect(read(await reopened.get('/1/0/0.pbf'))).toEqual([1, 2, 3]);
    expect(await reopened.get('/1/0/1.pbf')).toBeUndefined();
  });

  test('evicts the oldest entries when over maxEntries', async () => {
    const dbName = uniqueDbName();
    let time = 0;
    const store = createIndexedDbLruStore({ dbName, limits: { maxEntries: 2 }, now: () => ++time });

    await store.put('a', bytes(1));
    await store.put('b', bytes(2));
    await store.put('c', bytes(3));

    const reopened = createIndexedDbLruStore({ dbName, now: () => time });
    expect(await reopened.get('a')).toBeUndefined();
    expect(read(await reopened.get('b'))).toEqual([2]);
    expect(read(await reopened.get('c'))).toEqual([3]);
  });

  test('drops entries older than maxAgeMs', async () => {
    const dbName = uniqueDbName();
    let time = 0;
    const store = createIndexedDbLruStore({ dbName, limits: { maxAgeMs: 1000 }, now: () => time });

    await store.put('a', bytes(1));
    time = 1001;

    expect(await store.get('a')).toBeUndefined();
    time = 0;
    expect(await createIndexedDbLruStore({ dbName, now: () => time }).get('a')).toBeUndefined();
  });

  test('clear empties the database', async () => {
    const dbName = uniqueDbName();
    const store = createIndexedDbLruStore({ dbName });
    await store.put('a', bytes(1));

    await store.clear();

    expect(await store.get('a')).toBeUndefined();
    expect(await createIndexedDbLruStore({ dbName }).get('a')).toBeUndefined();
  });

  test('degrades to a no-op store when IndexedDB is unavailable', async () => {
    // @ts-expect-error simulating an environment without IndexedDB
    delete globalThis.indexedDB;
    const store = createIndexedDbLruStore({ dbName: uniqueDbName() });

    await expect(store.put('a', bytes(1))).resolves.toBeUndefined();
    await expect(store.get('a')).resolves.toBeUndefined();
  });
});
