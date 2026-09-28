import maplibregl, { type VectorTileSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { createTileCache } from '../../src';

const $ = (id: string) => document.getElementById(id)!;
let hits = 0;
let misses = 0;

const tileCache = createTileCache({
  limits: { maxEntries: 5000 },
  onTileLoad: ({ fromCache }) => {
    if (fromCache) hits++;
    else misses++;
    $('hits').textContent = String(hits);
    $('misses').textContent = String(misses);
  },
});
tileCache.registerProtocol(maplibregl.addProtocol);

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [10, 50],
  zoom: 3,
  transformRequest: tileCache.transformRequest,
});

/** What's on screen. With a bearing this is a rotated rectangle. */
const getViewportCorners = () => {
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  return [map.unproject([0, 0]), map.unproject([w, 0]), map.unproject([w, h]), map.unproject([0, h])] as const;
};

$('save').addEventListener('click', async () => {
  const source = map.getSource<VectorTileSource>('maplibre');
  if (!source?.tiles) return;

  // The current zoom plus up to two levels deeper, so zooming in still works offline.
  const zoom = Math.min(Math.floor(map.getZoom()), source.maxzoom);
  const zooms = Array.from({ length: Math.min(3, source.maxzoom - zoom + 1) }, (_, i) => zoom + i);

  try {
    const result = await tileCache.prefetchArea({
      corners: getViewportCorners(),
      zoom: zooms,
      tileUrl: source.tiles,
      onProgress: ({ completed, total }) => ($('status').textContent = `Saving ${completed}/${total}...`),
    });
    $('status').textContent =
      `Saved z${zooms.join(', z')}: ${result.fetched} downloaded, ${result.cached} already cached` +
      (result.failed ? `, ${result.failed} failed` : '');
  } catch (error) {
    $('status').textContent = error instanceof Error ? error.message : String(error);
  }
});

$('clear').addEventListener('click', async () => {
  await tileCache.clear();
  $('status').textContent = 'Cache cleared';
});
