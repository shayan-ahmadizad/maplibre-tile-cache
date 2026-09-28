import type { CacheLimits } from './types';

/**
 * Count-only LRU. Tracking byte sizes would need a separate metadata store and
 * more IndexedDB traffic per tile; origin quota is handled instead by dropping
 * the oldest 10% on `QuotaExceededError`.
 *
 * 1000 entries covers a city viewport across a few zooms plus glyph ranges
 * (roughly 10 to 20 MiB for typical vector tiles).
 */
export const DEFAULT_LIMITS: CacheLimits = {
  maxEntries: 1000,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_PROTOCOL = 'tilecache';
export const DEFAULT_DB_NAME = 'maplibre-tile-cache';
export const DB_VERSION = 1;
