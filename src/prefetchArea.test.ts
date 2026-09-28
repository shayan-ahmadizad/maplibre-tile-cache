import { describe, expect, test, vi } from 'vitest';
import { getTilesInArea } from './area';
import { createTileCache } from './createTileCache';
import { createMemoryLruStore } from './stores/memoryLruStore';
import type { LngLatLike, TileCacheOptions } from './types';

const template = 'https://tiles.example.com/data/v3/{z}/{x}/{y}.pbf';

/** Roughly central London; 4 tiles at z12, 12 at z13. */
const corners: [LngLatLike, LngLatLike, LngLatLike, LngLatLike] = [
  [-0.15, 51.52],
  [-0.05, 51.52],
  [-0.05, 51.49],
  [-0.15, 51.49],
];

const okResponse = (url: string) =>
  ({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new TextEncoder().encode(url).buffer) }) as Response;

const setup = (overrides?: TileCacheOptions) => {
  const store = createMemoryLruStore({ limits: { maxEntries: 1000 } });
  const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (input) => okResponse(String(input)));
  const cache = createTileCache({
    toCacheKey: (url) => new URL(url).pathname,
    store,
    fetch: fetchFn,
    ...overrides,
  });
  return { cache, store, fetchFn };
};

describe('prefetchArea', () => {
  test('downloads every tile in the area into the store', async () => {
    const { cache, store, fetchFn } = setup();
    const expected = getTilesInArea(corners, 13);

    const result = await cache.prefetchArea({ corners, zoom: 13, tileUrl: template });

    expect(result).toMatchObject({ total: expected.length, completed: expected.length, fetched: expected.length });
    expect(result.errors).toEqual([]);
    expect(fetchFn).toHaveBeenCalledTimes(expected.length);
    for (const { z, x, y } of expected) {
      expect(store.records.has(`/data/v3/${z}/${x}/${y}.pbf`)).toBe(true);
    }
  });

  test('stores tiles under the same key the map uses, so later loads skip the network', async () => {
    const { cache, fetchFn } = setup({
      toCanonicalUrl: (url) => url.replace('cdn.example.com', 'tiles.example.com'),
    });
    await cache.prefetchArea({ corners, zoom: 12, tileUrl: 'https://cdn.example.com/data/v3/{z}/{x}/{y}.pbf' });
    fetchFn.mockClear();

    const [tile] = getTilesInArea(corners, 12);
    const mapRequest = cache.transformRequest(`https://tiles.example.com/data/v3/12/${tile!.x}/${tile!.y}.pbf`);
    await cache.load(mapRequest, new AbortController());

    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('skips tiles that are already cached', async () => {
    const { cache, fetchFn } = setup();
    await cache.prefetchArea({ corners, zoom: 12, tileUrl: template });
    fetchFn.mockClear();

    const result = await cache.prefetchArea({ corners, zoom: [12, 13], tileUrl: template });

    const atZ12 = getTilesInArea(corners, 12).length;
    const atZ13 = getTilesInArea(corners, 13).length;
    expect(result).toMatchObject({ total: atZ12 + atZ13, cached: atZ12, fetched: atZ13 });
    expect(fetchFn).toHaveBeenCalledTimes(atZ13);
  });

  test('accepts a URL function', async () => {
    const { cache, fetchFn } = setup();

    await cache.prefetchArea({
      corners,
      zoom: 12,
      tileUrl: ({ z, x, y }) => `https://tiles.example.com/tms/${z}/${x}/${2 ** z - 1 - y}.pbf`,
    });

    expect(fetchFn.mock.calls.every(([url]) => String(url).includes('/tms/12/'))).toBe(true);
  });

  test('refuses areas larger than maxTiles before downloading anything', async () => {
    const { cache, fetchFn } = setup();

    await expect(cache.prefetchArea({ corners, zoom: 13, tileUrl: template, maxTiles: 5 })).rejects.toThrow(RangeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test('defaults maxTiles to limits.maxEntries', async () => {
    const { cache } = setup({ limits: { maxEntries: 3 } });

    await expect(cache.prefetchArea({ corners, zoom: 12, tileUrl: template })).rejects.toThrow(
      /more than maxTiles \(3\)/,
    );
  });

  test('keeps going when a tile fails and reports it', async () => {
    const { cache, fetchFn } = setup();
    const [broken] = getTilesInArea(corners, 13);
    fetchFn.mockImplementation(async (input) =>
      String(input).endsWith(`/${broken!.x}/${broken!.y}.pbf`)
        ? ({ ok: false, status: 404, statusText: 'Not Found' } as Response)
        : okResponse(String(input)),
    );

    const result = await cache.prefetchArea({ corners, zoom: 13, tileUrl: template });

    expect(result.failed).toBe(1);
    expect(result.fetched).toBe(result.total - 1);
    expect(result.errors).toEqual([{ tile: broken, error: expect.any(Error) }]);
  });

  test('reports progress after every tile', async () => {
    const { cache } = setup();
    const onProgress = vi.fn();

    const result = await cache.prefetchArea({ corners, zoom: 13, tileUrl: template, onProgress });

    expect(onProgress).toHaveBeenCalledTimes(result.total);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ completed: result.total }));
  });

  test('never has more than `concurrency` requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const { cache } = setup({
      fetch: async (input) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return okResponse(String(input));
      },
    });

    await cache.prefetchArea({ corners, zoom: 13, tileUrl: template, concurrency: 2 });

    expect(peak).toBe(2);
  });

  test('stops and rejects when aborted', async () => {
    const { cache, fetchFn } = setup();
    const controller = new AbortController();

    const run = cache.prefetchArea({
      corners,
      zoom: 13,
      tileUrl: template,
      concurrency: 1,
      signal: controller.signal,
      onProgress: ({ completed }) => completed === 2 && controller.abort(),
    });

    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
