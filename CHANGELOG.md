# Changelog

## 0.1.0

First release.

- `createTileCache` with a cache-first MapLibre protocol handler for `.pbf` tiles and glyphs
- IndexedDB store with LRU eviction by entry count, max age, and quota recovery
- In-memory store with the same rules
- `prefetchArea` to download every tile inside a (possibly rotated) rectangle at one or more zoom levels
- `getTilesInArea` and `lngLatToTile` helpers
