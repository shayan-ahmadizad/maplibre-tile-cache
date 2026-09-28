import type { LngLatLike, TileCoord } from './types';

/** Web Mercator's cut-off. There are no tiles past it. */
const MAX_LATITUDE = 85.0511287798066;
const MAX_ZOOM = 30;

type Point = { x: number; y: number };

const toLngLat = (point: LngLatLike): { lng: number; lat: number } =>
  'lng' in point ? { lng: point.lng, lat: point.lat } : { lng: point[0], lat: point[1] };

const assertZoom = (zoom: number) => {
  if (!Number.isInteger(zoom) || zoom < 0 || zoom > MAX_ZOOM) {
    throw new RangeError(`Zoom must be an integer between 0 and ${MAX_ZOOM}, got ${zoom}`);
  }
};

/** Fractional position in tile units at `zoom`. `Math.floor` of each axis gives the tile. */
const projectToTileSpace = (point: LngLatLike, zoom: number): Point => {
  const { lng, lat } = toLngLat(point);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new TypeError(`Invalid coordinate: [${lng}, ${lat}]`);
  }
  const scale = 2 ** zoom;
  const clampedLat = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const latRad = (clampedLat * Math.PI) / 180;

  return {
    x: ((lng + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2) * scale,
  };
};

/** The tile containing `point` at `zoom`. */
export const lngLatToTile = (point: LngLatLike, zoom: number): TileCoord => {
  assertZoom(zoom);
  const { x, y } = projectToTileSpace(point, zoom);
  const last = 2 ** zoom - 1;
  return {
    z: zoom,
    x: Math.min(last, Math.max(0, Math.floor(x))),
    y: Math.min(last, Math.max(0, Math.floor(y))),
  };
};

/**
 * Corners can come in any order (clockwise, counter-clockwise, or zigzag).
 * Sorting by angle around the centroid turns them back into a simple polygon.
 */
const orderAroundCentroid = (points: Point[]): Point[] => {
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const angle = (p: Point) => Math.atan2(p.y - cy, p.x - cx);
  return [...points].sort((a, b) => angle(a) - angle(b));
};

const projectOnto = (points: readonly Point[], axis: Point) => {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    const d = p.x * axis.x + p.y * axis.y;
    if (d < min) min = d;
    if (d > max) max = d;
  }
  return { min, max };
};

/**
 * Every tile whose square intersects the quadrilateral described by `corners`.
 *
 * Corners are projected to Web Mercator first, since that's where the sides of
 * a map viewport are straight lines. Each tile in the bounding box is then
 * tested against the polygon with the separating axis theorem. An axis-aligned
 * rectangle gives you the whole bounding box. A rotated one leaves out the tiles
 * that only sit in the empty triangles around it.
 *
 * Areas crossing the antimeridian aren't split. Pass them as two areas.
 */
export const getTilesInArea = (corners: readonly LngLatLike[], zoom: number): TileCoord[] => {
  assertZoom(zoom);
  if (corners.length !== 4) {
    throw new RangeError(`Expected 4 corners, got ${corners.length}`);
  }

  const polygon = orderAroundCentroid(corners.map((corner) => projectToTileSpace(corner, zoom)));
  const last = 2 ** zoom - 1;
  const xs = polygon.map((p) => p.x);
  const ys = polygon.map((p) => p.y);

  // `ceil - 1` keeps an edge that sits exactly on a tile boundary from pulling in the neighbour.
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxX = Math.min(last, Math.max(minX, Math.ceil(Math.max(...xs)) - 1));
  const maxY = Math.min(last, Math.max(minY, Math.ceil(Math.max(...ys)) - 1));

  // The tile grid already covers the x/y axes, so only the polygon's edge normals need checking.
  const axes = polygon.map((p, i) => {
    const next = polygon[(i + 1) % polygon.length]!;
    return { x: p.y - next.y, y: next.x - p.x };
  });
  const polygonSpans = axes.map((axis) => projectOnto(polygon, axis));

  const tiles: TileCoord[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      const square = [
        { x, y },
        { x: x + 1, y },
        { x: x + 1, y: y + 1 },
        { x, y: y + 1 },
      ];
      const intersects = axes.every((axis, i) => {
        const tileSpan = projectOnto(square, axis);
        const polygonSpan = polygonSpans[i]!;
        return tileSpan.max >= polygonSpan.min && polygonSpan.max >= tileSpan.min;
      });
      if (intersects) {
        tiles.push({ z: zoom, x, y });
      }
    }
  }
  return tiles;
};

/**
 * Fills `{z}`, `{x}` and `{y}` in a tile URL template. With several templates,
 * the same one MapLibre would pick for this tile is used, so prefetched URLs
 * match the ones the map requests later.
 */
export const resolveTileUrl = (template: string | readonly string[], tile: TileCoord): string => {
  const templates = typeof template === 'string' ? [template] : template;
  if (templates.length === 0) {
    throw new RangeError('tileUrl must contain at least one template');
  }
  const picked = templates[(tile.x + tile.y) % templates.length]!;
  return picked.replace(/\{z\}/g, String(tile.z)).replace(/\{x\}/g, String(tile.x)).replace(/\{y\}/g, String(tile.y));
};
