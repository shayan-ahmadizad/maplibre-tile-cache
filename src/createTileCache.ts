import { getTilesInArea, resolveTileUrl } from './area';
import { DEFAULT_PROTOCOL } from './constants';
import { runPrefetch } from './prefetch';
import { createIndexedDbLruStore } from './stores/indexedDbLruStore';
import { resolveLimits } from './stores/lruPolicy';
import type { TileCache, TileCacheOptions, TileCoord } from './types';
import { insecureProtocol, isCustomProtocolUrl, isPbfUrl, stripCustomProtocol, toCustomProtocolUrl } from './urls';

const DEFAULT_CONCURRENCY = 6;

const identity = (url: string) => url;

/**
 * Cache-first tile loader for MapLibre: served from the store on a hit, fetched
 * and stored on a miss.
 *
 * `transformRequest` moves cacheable URLs onto a custom protocol and the handler
 * registered with `addProtocol` does the lookup. Styles, sprites and TileJSON
 * don't match by default and go over the network as usual.
 *
 * Workbox's `ExpirationPlugin` has the same policy (max entries, max age, LRU),
 * but it only runs inside a service worker against Cache Storage. This runs in
 * the page, so it still works when you don't control the service worker.
 *
 * @example
 * const tileCache = createTileCache();
 * tileCache.registerProtocol(maplibregl.addProtocol);
 * new maplibregl.Map({ container, style, transformRequest: tileCache.transformRequest });
 */
export const createTileCache = (options: TileCacheOptions = {}): TileCache => {
  const {
    protocol = DEFAULT_PROTOCOL,
    isCacheableUrl = isPbfUrl,
    toCanonicalUrl = identity,
    toCacheKey = identity,
    rewriteFetchUrl = identity,
    isEnabled = () => true,
    fetch: fetchFn = (input, init) => globalThis.fetch(input, init),
    onTileLoad,
  } = options;

  const limits = resolveLimits(options.limits);
  const store = options.store ?? createIndexedDbLruStore({ limits });
  let didRegister = false;

  const fromProtocolUrl = (url: string) => stripCustomProtocol(protocol, url);
  const toProtocolUrl = (url: string) => toCustomProtocolUrl(protocol, toCanonicalUrl(fromProtocolUrl(url)));

  const download = async (canonicalUrl: string, init: RequestInit): Promise<ArrayBuffer> => {
    const response = await fetchFn(rewriteFetchUrl(canonicalUrl), init);
    if (!response.ok) {
      throw new Error(response.statusText || `Tile request failed with status ${response.status}`);
    }
    return response.arrayBuffer();
  };

  // A broken store must never break the map, so read errors count as a miss.
  const readFromStore = (key: string) => store.get(key).catch(() => undefined);

  const load: TileCache['load'] = async (request, abortController) => {
    const canonicalUrl = toCanonicalUrl(fromProtocolUrl(request.url));
    const key = toCacheKey(canonicalUrl);
    const startedAt = performance.now();

    const cached = await readFromStore(key);
    if (cached) {
      onTileLoad?.({ url: canonicalUrl, durationMs: performance.now() - startedAt, fromCache: true });
      return { data: cached };
    }

    const data = await download(canonicalUrl, {
      headers: request.headers,
      credentials: request.credentials,
      signal: abortController.signal,
    });
    // MapLibre transfers `data` to a worker, which detaches it. Store a copy.
    void store.put(key, data.slice(0)).catch(() => undefined);
    onTileLoad?.({ url: canonicalUrl, durationMs: performance.now() - startedAt, fromCache: false });
    return { data };
  };

  const prefetchArea: TileCache['prefetchArea'] = async ({
    corners,
    zoom,
    tileUrl,
    concurrency = DEFAULT_CONCURRENCY,
    maxTiles = limits.maxEntries,
    signal,
    onProgress,
  }) => {
    const zooms = typeof zoom === 'number' ? [zoom] : zoom;
    const tiles = zooms.flatMap((z) => getTilesInArea(corners, z));
    if (tiles.length > maxTiles) {
      throw new RangeError(
        `This area covers ${tiles.length} tiles, more than maxTiles (${maxTiles}). ` +
          'Use a lower zoom, a smaller area, or raise maxTiles together with limits.maxEntries.',
      );
    }

    const urlFor = (tile: TileCoord) => (typeof tileUrl === 'function' ? tileUrl(tile) : resolveTileUrl(tileUrl, tile));

    return runPrefetch(
      tiles,
      async (tile, tileSignal) => {
        const canonicalUrl = toCanonicalUrl(urlFor(tile));
        const key = toCacheKey(canonicalUrl);
        if (await readFromStore(key)) {
          return 'cached';
        }
        const data = await download(canonicalUrl, { signal: tileSignal });
        await store.put(key, data);
        return 'fetched';
      },
      { concurrency, signal, onProgress },
    );
  };

  return {
    fromProtocolUrl,
    toProtocolUrl,
    transformRequest: (url, resourceType) => {
      if (isEnabled() && isCacheableUrl(url, resourceType)) {
        const protocolUrl = toProtocolUrl(url);
        // Relative or non-http URLs cannot be mapped onto the protocol; let MapLibre fetch them.
        if (isCustomProtocolUrl(protocol, protocolUrl)) {
          return { url: protocolUrl };
        }
      }
      return { url: rewriteFetchUrl(url) };
    },
    load,
    registerProtocol: (addProtocol) => {
      if (didRegister) {
        return;
      }
      didRegister = true;
      addProtocol(protocol, load);
      addProtocol(insecureProtocol(protocol), load);
    },
    prefetchArea,
    clear: async () => {
      await store.clear?.();
    },
  };
};
