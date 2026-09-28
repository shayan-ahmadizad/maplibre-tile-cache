/**
 * Byte store behind the cache. Keys come from `toCacheKey`, values are raw
 * response bodies (PBF, PNG, whatever the tile server returns).
 *
 * Implement this to back the cache with something other than IndexedDB.
 * Writes are best-effort and shouldn't reject: by the time `put` runs, the
 * tile has already been served from the network.
 */
export type TileStore = {
  get: (key: string) => Promise<ArrayBuffer | undefined>;
  put: (key: string, data: ArrayBuffer) => Promise<void>;
  clear?: () => Promise<void>;
};

/**
 * LRU capacity.
 *
 * - `maxEntries` bounds the number of stored tiles and the eviction work per write.
 * - `maxAgeMs` drops entries that have not been read or written within the window.
 */
export type CacheLimits = {
  maxEntries: number;
  maxAgeMs: number;
};

export type LruEntry = {
  key: string;
  lastAccess: number;
};

/** `[lng, lat]` tuple or any `{ lng, lat }` object, so MapLibre's `LngLat` works as is. */
export type LngLatLike = readonly [lng: number, lat: number] | { lng: number; lat: number };

/** XYZ tile address, same scheme as `{z}/{x}/{y}` in tile URLs. */
export type TileCoord = {
  z: number;
  x: number;
  y: number;
};

/**
 * Where to download tiles from when prefetching. Either a URL template with
 * `{z}`, `{x}` and `{y}` placeholders, a list of templates (picked the same way
 * MapLibre picks from a source's `tiles` array), or a function.
 */
export type TileUrlTemplate = string | readonly string[] | ((tile: TileCoord) => string);

export type TileLoadEvent = {
  /** Canonical URL of the tile, after `toCanonicalUrl`. */
  url: string;
  durationMs: number;
  fromCache: boolean;
};

/** Subset of MapLibre's `RequestParameters` that the loader actually uses. */
export type TileRequest = {
  url: string;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
};

export type ProtocolLoadFn = (request: TileRequest, abortController: AbortController) => Promise<{ data: ArrayBuffer }>;

/** Shape of `maplibregl.addProtocol` (MapLibre GL JS v4+). */
export type AddProtocol = (protocol: string, loadFn: ProtocolLoadFn) => void;

export type TileCacheOptions = {
  /**
   * Custom protocol registered with MapLibre, without `://`.
   * @default 'tilecache'
   */
  protocol?: string;
  /**
   * Which requests go through the cache. `resourceType` is the second argument
   * MapLibre passes to `transformRequest` (`'Tile'`, `'Glyphs'`, `'Style'`, ...).
   * @default isPbfUrl
   */
  isCacheableUrl?: (url: string, resourceType?: string) => boolean;
  /**
   * Maps equivalent URLs (mirrors, proxies, CDN hosts) onto one URL before it is
   * keyed and fetched.
   * @default identity
   */
  toCanonicalUrl?: (url: string) => string;
  /**
   * Turns a canonical URL into a store key. Drop anything that changes between
   * sessions but not the tile itself, such as short-lived tokens.
   * @default identity
   */
  toCacheKey?: (canonicalUrl: string) => string;
  /** Last chance to change the URL that is actually fetched, e.g. to route through a proxy. */
  rewriteFetchUrl?: (url: string) => string;
  /** Checked on every request, so the cache can be switched on and off at runtime. */
  isEnabled?: () => boolean;
  /** @default createIndexedDbLruStore({ limits }) */
  store?: TileStore;
  /** Used for the default store and as the default `maxTiles` for prefetching. */
  limits?: Partial<CacheLimits>;
  fetch?: typeof fetch;
  onTileLoad?: (event: TileLoadEvent) => void;
};

export type PrefetchProgress = {
  total: number;
  completed: number;
  /** Downloaded and written to the store. */
  fetched: number;
  /** Already cached, nothing downloaded. */
  cached: number;
  failed: number;
};

export type PrefetchResult = PrefetchProgress & {
  errors: { tile: TileCoord; error: unknown }[];
};

export type PrefetchAreaOptions = {
  /** Four corners of the area, in any order. Rotated rectangles are fine. */
  corners: readonly [LngLatLike, LngLatLike, LngLatLike, LngLatLike];
  /** Tile zoom level (the `{z}` in the URL). Pass an array to cover several levels in one go. */
  zoom: number | readonly number[];
  tileUrl: TileUrlTemplate;
  /** @default 6 */
  concurrency?: number;
  /**
   * Refuses to start when the area covers more tiles than this. Prefetched tiles
   * share the LRU with everything else, so going over `limits.maxEntries` would
   * evict the tiles you just downloaded.
   * @default limits.maxEntries
   */
  maxTiles?: number;
  signal?: AbortSignal;
  onProgress?: (progress: PrefetchProgress) => void;
};

export type TileCache = {
  /** Pass this as MapLibre's `transformRequest` (or call it from yours). */
  transformRequest: (url: string, resourceType?: string) => { url: string };
  /** Registers the protocol handler. Safe to call more than once. */
  registerProtocol: (addProtocol: AddProtocol) => void;
  /** The protocol handler itself. Exposed for custom setups and tests. */
  load: ProtocolLoadFn;
  toProtocolUrl: (url: string) => string;
  fromProtocolUrl: (url: string) => string;
  /** Downloads every tile that intersects the given area and stores it. */
  prefetchArea: (options: PrefetchAreaOptions) => Promise<PrefetchResult>;
  /** Empties the store. No-op for stores without `clear`. */
  clear: () => Promise<void>;
};
