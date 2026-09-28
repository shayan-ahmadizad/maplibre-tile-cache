import { describe, expect, test, vi } from 'vitest';
import { createTileCache } from './createTileCache';
import { createMemoryLruStore } from './stores/memoryLruStore';
import type { TileCacheOptions, TileStore } from './types';

const tileUrl = 'https://tiles.example.com/data/v3/14/10530/6446.pbf';
const tileKey = '/data/v3/14/10530/6446.pbf';
const styleUrl = 'https://tiles.example.com/styles/basic/style.json';

const okResponse = (...values: number[]) =>
  ({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new Uint8Array(values).buffer) }) as Response;

const setup = (overrides?: TileCacheOptions) => {
  const store = createMemoryLruStore({ limits: { maxEntries: 10, maxAgeMs: 60_000 } });
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(okResponse(4, 5, 6));
  const cache = createTileCache({
    toCacheKey: (url) => new URL(url).pathname,
    store,
    fetch: fetchFn,
    ...overrides,
  });
  return { cache, store, fetchFn };
};

describe('transformRequest', () => {
  test('moves pbf URLs onto the custom protocol and leaves the rest alone', () => {
    const { cache } = setup();

    expect(cache.transformRequest(tileUrl)).toEqual({ url: 'tilecache://tiles.example.com/data/v3/14/10530/6446.pbf' });
    expect(cache.transformRequest('http://localhost:8080/1/0/0.pbf')).toEqual({
      url: 'tilecache+http://localhost:8080/1/0/0.pbf',
    });
    expect(cache.transformRequest(styleUrl)).toEqual({ url: styleUrl });
  });

  test('passes through when disabled', () => {
    let enabled = false;
    const { cache } = setup({ isEnabled: () => enabled });

    expect(cache.transformRequest(tileUrl)).toEqual({ url: tileUrl });
    enabled = true;
    expect(cache.transformRequest(tileUrl).url).toMatch(/^tilecache:\/\//);
  });

  test('uses the custom matcher and resource type', () => {
    const { cache } = setup({ isCacheableUrl: (_, resourceType) => resourceType === 'Tile' });

    expect(cache.transformRequest('https://tiles.example.com/1/0/0.png', 'Tile').url).toMatch(/^tilecache:\/\//);
    expect(cache.transformRequest('https://tiles.example.com/1/0/0.png', 'Image').url).toMatch(/^https:\/\//);
  });

  test('does not rewrite relative URLs', () => {
    const { cache } = setup();

    expect(cache.transformRequest('/tiles/1/0/0.pbf')).toEqual({ url: '/tiles/1/0/0.pbf' });
  });

  test('applies toCanonicalUrl before rewriting and rewriteFetchUrl to everything else', () => {
    const { cache } = setup({
      toCanonicalUrl: (url) => url.replace('mirror.example.com', 'tiles.example.com'),
      rewriteFetchUrl: (url) => `${url}?via=proxy`,
    });

    expect(cache.transformRequest('https://mirror.example.com/1/0/0.pbf')).toEqual({
      url: 'tilecache://tiles.example.com/1/0/0.pbf',
    });
    expect(cache.transformRequest(styleUrl)).toEqual({ url: `${styleUrl}?via=proxy` });
  });
});

describe('load', () => {
  test('returns a cached body without fetching', async () => {
    const { cache, store, fetchFn } = setup();
    const data = new Uint8Array([1, 2, 3]).buffer;
    await store.put(tileKey, data);

    const result = await cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController());

    expect(result.data).toBe(data);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('fetches on a miss and stores a copy', async () => {
    const { cache, store, fetchFn } = setup();

    const result = await cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController());

    expect(fetchFn).toHaveBeenCalledWith(tileUrl, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect([...new Uint8Array(result.data)]).toEqual([4, 5, 6]);
    expect(store.records.get(tileKey)).not.toBe(result.data);
    expect([...new Uint8Array(store.records.get(tileKey)!)]).toEqual([4, 5, 6]);
  });

  test('forwards headers and credentials from MapLibre', async () => {
    const { cache, fetchFn } = setup();

    await cache.load(
      { url: cache.toProtocolUrl(tileUrl), headers: { Authorization: 'Bearer abc' }, credentials: 'include' },
      new AbortController(),
    );

    expect(fetchFn).toHaveBeenCalledWith(
      tileUrl,
      expect.objectContaining({ headers: { Authorization: 'Bearer abc' }, credentials: 'include' }),
    );
  });

  test('reports cache hits and network loads to onTileLoad', async () => {
    const onTileLoad = vi.fn();
    const { cache } = setup({ onTileLoad });

    await cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController());
    await cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController());

    expect(onTileLoad).toHaveBeenNthCalledWith(1, expect.objectContaining({ url: tileUrl, fromCache: false }));
    expect(onTileLoad).toHaveBeenNthCalledWith(2, expect.objectContaining({ url: tileUrl, fromCache: true }));
    expect(onTileLoad.mock.calls[0]![0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('does not cache a failed response', async () => {
    const { cache, store, fetchFn } = setup();
    fetchFn.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' } as Response);

    await expect(cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController())).rejects.toThrow(
      'Service Unavailable',
    );
    expect(store.records.size).toBe(0);
  });

  test('falls back to the network when the store fails', async () => {
    const brokenStore: TileStore = {
      get: () => Promise.reject(new Error('disk on fire')),
      put: () => Promise.reject(new Error('disk on fire')),
    };
    const { cache } = setup({ store: brokenStore });

    const result = await cache.load({ url: cache.toProtocolUrl(tileUrl) }, new AbortController());

    expect([...new Uint8Array(result.data)]).toEqual([4, 5, 6]);
  });
});

describe('registerProtocol', () => {
  test('registers the https and http variants once', () => {
    const { cache } = setup({ protocol: 'tiles' });
    const addProtocol = vi.fn();

    cache.registerProtocol(addProtocol);
    cache.registerProtocol(addProtocol);

    expect(addProtocol.mock.calls.map(([name]) => name)).toEqual(['tiles', 'tiles+http']);
    expect(addProtocol).toHaveBeenCalledWith('tiles', cache.load);
  });
});

describe('clear', () => {
  test('empties the store', async () => {
    const { cache, store } = setup();
    await store.put(tileKey, new Uint8Array([1]).buffer);

    await cache.clear();

    expect(store.records.size).toBe(0);
  });
});
