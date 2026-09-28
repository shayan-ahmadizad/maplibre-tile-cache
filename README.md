# maplibre-tile-cache

Stores MapLibre GL JS tiles in IndexedDB, so an area of the map that has been seen once loads from disk next time. You can also download an area ahead of time for offline use.

It hooks into MapLibre through `transformRequest` and `addProtocol`, so there's no service worker to set up. By default it caches `.pbf` requests (vector tiles and glyph ranges). Once the cache is full, the least recently used tiles are evicted, and tiles nobody has looked at for a week are dropped.

```sh
npm install maplibre-tile-cache
```

It needs MapLibre GL JS 4 or newer, since it uses the promise-based `addProtocol`. It's tested with 5.x and has no runtime dependencies.

## Usage

```ts
import maplibregl from 'maplibre-gl';
import { createTileCache } from 'maplibre-tile-cache';

const tileCache = createTileCache();
tileCache.registerProtocol(maplibregl.addProtocol);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  transformRequest: tileCache.transformRequest,
});
```

Create the cache once for the whole app. Protocols in MapLibre are global, and every map can share the same `transformRequest`.

With react-map-gl, do the setup at module level and pass the same function:

```tsx
import maplibregl from 'maplibre-gl';
import Map from 'react-map-gl/maplibre';

const tileCache = createTileCache();
tileCache.registerProtocol(maplibregl.addProtocol);

export const AppMap = () => <Map mapStyle={styleUrl} transformRequest={tileCache.transformRequest} />;
```

If you already have a `transformRequest`, for example to add an auth header, spread the result. Headers and credentials are passed on to the tile request.

```ts
transformRequest: (url, resourceType) => ({
  ...tileCache.transformRequest(url, resourceType),
  headers: { Authorization: `Bearer ${token}` },
}),
```

## Saving an area for offline use

`prefetchArea` takes the four corners of a rectangle and a zoom level, works out which tiles cover it, and downloads the ones that aren't cached yet. The corners can be in any order, and the rectangle can be rotated. Only tiles that actually overlap it are fetched, so a tilted viewport doesn't pull in the whole bounding box.

To save what's on screen right now:

```ts
import type { VectorTileSource } from 'maplibre-gl';

const { clientWidth: w, clientHeight: h } = map.getContainer();
const corners = [map.unproject([0, 0]), map.unproject([w, 0]), map.unproject([w, h]), map.unproject([0, h])] as const;

const source = map.getSource<VectorTileSource>('openmaptiles')!;
const controller = new AbortController();

const result = await tileCache.prefetchArea({
  corners,
  zoom: [12, 13, 14],
  tileUrl: source.tiles!,
  signal: controller.signal,
  onProgress: ({ completed, total }) => console.log(`${completed}/${total}`),
});

console.log(`${result.fetched} downloaded, ${result.cached} were already there, ${result.failed} failed`);
```

Corners can be `[lng, lat]` pairs or anything with `lng` and `lat`, so MapLibre's `LngLat` objects work too. `tileUrl` can be a template like `https://tiles.example.com/{z}/{x}/{y}.pbf`, the `tiles` array from a source (a tile is picked from it the same way MapLibre does), or a function `({ z, x, y }) => string` for anything else, such as TMS.

A few things to keep in mind:

- `zoom` is the tile zoom, the `{z}` in the URL. For 512px vector tiles that's `Math.floor(map.getZoom())`. For 256px raster tiles it's one level higher.
- A failed tile doesn't stop the run. It's counted in `failed` and listed in `result.errors`. Calling `controller.abort()` stops the run and rejects with an `AbortError`.
- Saved tiles share the LRU with everything else. When an area covers more tiles than `limits.maxEntries`, the download would evict its own tiles, so `prefetchArea` throws a `RangeError` before fetching anything. Raise `limits.maxEntries` (or pass `maxTiles`) if you want to save big areas. Saved tiles also expire after `limits.maxAgeMs` if they're never viewed.
- To show a size before downloading, `getTilesInArea(corners, zoom).length` gives the tile count.

The style JSON, TileJSON and sprites aren't tiles, so they still come from the network. For a map that works fully offline, cache those separately, either with a service worker or by bundling them with your app.

## Options

```ts
createTileCache({
  // Custom protocol name. Plain-http URLs use `${protocol}+http`.
  protocol: 'tilecache',

  // Which requests to cache. resourceType is what MapLibre passes to
  // transformRequest: 'Tile', 'Glyphs', 'Style', 'Source', ...
  isCacheableUrl: (url, resourceType) => isPbfUrl(url),

  // Maps equivalent URLs (mirrors, proxies) to one URL before it's keyed and fetched.
  toCanonicalUrl: (url) => url,

  // Turns the canonical URL into a store key.
  toCacheKey: (url) => url,

  // Changes the URL that is actually fetched on a miss.
  rewriteFetchUrl: (url) => url,

  // Checked on every request, so you can flip the cache on and off at runtime.
  isEnabled: () => true,

  limits: { maxEntries: 1000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 },
  store: createIndexedDbLruStore({ limits }),
  fetch: globalThis.fetch,

  // Called for every tile the handler serves.
  onTileLoad: ({ url, durationMs, fromCache }) => {},
});
```

### Keys that survive proxies and tokens

Say tiles come from `tiles.example.com`, but some traffic goes through a proxy on your own origin, and the URL carries an API key that rotates. You want one cache entry per tile no matter which route or key was used:

```ts
const tileCache = createTileCache({
  toCanonicalUrl: (url) => url.replace(`${location.origin}/map-proxy`, 'https://tiles.example.com'),
  toCacheKey: (url) => new URL(url).pathname,
});
```

### Raster tiles

The handler stores whatever bytes the server returns, so raster tiles work as well. Match on the resource type instead of the file extension:

```ts
createTileCache({ isCacheableUrl: (_, resourceType) => resourceType === 'Tile' });
```

### Stores

`createIndexedDbLruStore` is the default. `createMemoryLruStore` follows the same LRU rules without persisting anything, which is useful in tests. Any object with `get(key)`, `put(key, data)` and optionally `clear()` works as a store.

If IndexedDB is missing or won't open (some private browsing modes), the store does nothing and the map loads from the network as usual. The same goes for read and write errors.

`tileCache.clear()` empties the store.

## How it works

`transformRequest` rewrites `https://host/path.pbf` to `tilecache://host/path.pbf`. The scheme is folded in because MapLibre parses `tilecache://https://host/...` with `https` as the host. When MapLibre asks the protocol handler for the tile, the handler turns the URL back into `https://`, builds the key and checks the store. On a miss it fetches the tile, hands the bytes to MapLibre and writes a copy to IndexedDB. The copy is needed because MapLibre transfers the buffer to a worker.

The IndexedDB side is a single object store of `{ key, data, lastAccess }` with an index on `lastAccess`. All keys are kept in a `Set` in memory, so a miss doesn't touch the database. Eviction walks a key cursor on the index, so tile bytes are never read just to be deleted. `lastAccess` is refreshed at most once per tile per page load. That keeps panning from rewriting tiles over and over, and it's also why the LRU order is only approximate within one session. If the browser reports the origin is out of quota, the oldest 10% of `maxEntries` are dropped and the write is retried once.

Workbox's `ExpirationPlugin` uses the same policy, but only inside a service worker and only against Cache Storage. This library runs in the page, so it also works when you don't control the service worker, for example inside a WebView or on a site where another team owns it.

## Known limitations

- Areas that cross the antimeridian aren't split. Save them as two areas.
- Limits are by tile count, not bytes. For typical vector tiles, 1000 entries comes to about 10 to 20 MiB.
- If the map and a prefetch ask for the same missing tile at the same time, it's downloaded twice.

## Development

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm example   # MapLibre demo tiles on http://localhost:5173 with a "Save this view" button
```

## License

MIT
