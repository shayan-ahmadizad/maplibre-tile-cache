import { describe, expect, test } from 'vitest';
import { getTilesInArea, lngLatToTile, resolveTileUrl } from './area';
import type { TileCoord } from './types';

/** Inverse Web Mercator: fractional tile position back to [lng, lat]. */
const tileSpaceToLngLat = (x: number, y: number, z: number): [number, number] => {
  const scale = 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / scale))) * 180) / Math.PI;
  return [lng, lat];
};

const sortTiles = (tiles: TileCoord[]) => [...tiles].sort((a, b) => a.x - b.x || a.y - b.y);

describe('lngLatToTile', () => {
  test('matches known tile addresses', () => {
    expect(lngLatToTile([0, 0], 0)).toEqual({ z: 0, x: 0, y: 0 });
    expect(lngLatToTile([-90, 45], 1)).toEqual({ z: 1, x: 0, y: 0 });
    expect(lngLatToTile({ lng: 90, lat: -45 }, 1)).toEqual({ z: 1, x: 1, y: 1 });
    // London
    expect(lngLatToTile([-0.1276, 51.5072], 10)).toEqual({ z: 10, x: 511, y: 340 });
  });

  test('clamps the poles and the antimeridian into the tile grid', () => {
    expect(lngLatToTile([180, 90], 2)).toEqual({ z: 2, x: 3, y: 0 });
    expect(lngLatToTile([-180, -90], 2)).toEqual({ z: 2, x: 0, y: 3 });
  });
});

describe('getTilesInArea', () => {
  test('returns the tile grid of an axis-aligned rectangle without the neighbours on its edges', () => {
    // At z3 x runs 2..4 exactly and y runs ~2.3..4, so the right and bottom edges sit on tile boundaries.
    const tiles = getTilesInArea(
      [
        [-90, 60],
        [0, 60],
        [0, 0],
        [-90, 0],
      ],
      3,
    );

    expect(sortTiles(tiles)).toEqual([
      { z: 3, x: 2, y: 2 },
      { z: 3, x: 2, y: 3 },
      { z: 3, x: 3, y: 2 },
      { z: 3, x: 3, y: 3 },
    ]);
  });

  test('skips tiles outside a rotated rectangle', () => {
    // A square rotated 45° around tile-space (8, 8) at z4: |x - 8| + |y - 8| <= 3.5.
    const z = 4;
    const diamond = [
      tileSpaceToLngLat(8, 4.5, z),
      tileSpaceToLngLat(11.5, 8, z),
      tileSpaceToLngLat(8, 11.5, z),
      tileSpaceToLngLat(4.5, 8, z),
    ] as const;

    const tiles = getTilesInArea(diamond, z);

    // The bounding box is 8x8 = 64 tiles; 24 of them only touch the empty corners.
    expect(tiles).toHaveLength(40);
    expect(tiles).toContainEqual({ z, x: 7, y: 4 });
    expect(tiles).not.toContainEqual({ z, x: 4, y: 4 });
    expect(tiles).not.toContainEqual({ z, x: 5, y: 5 });
  });

  test('does not care about corner order', () => {
    const z = 4;
    const [a, b, c, d] = [
      tileSpaceToLngLat(8, 4.5, z),
      tileSpaceToLngLat(11.5, 8, z),
      tileSpaceToLngLat(8, 11.5, z),
      tileSpaceToLngLat(4.5, 8, z),
    ];

    expect(sortTiles(getTilesInArea([a, c, b, d], z))).toEqual(sortTiles(getTilesInArea([a, b, c, d], z)));
  });

  test('returns the single tile for an area smaller than a tile', () => {
    const point: [number, number] = [-0.1276, 51.5072];

    expect(getTilesInArea([point, point, point, point], 10)).toEqual([{ z: 10, x: 511, y: 340 }]);
  });

  test('rejects bad input', () => {
    const corners = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ] as const;

    expect(() => getTilesInArea(corners, 1.5)).toThrow(RangeError);
    expect(() => getTilesInArea(corners, -1)).toThrow(RangeError);
    expect(() => getTilesInArea(corners.slice(0, 3), 2)).toThrow(RangeError);
    expect(() =>
      getTilesInArea(
        [
          [0, 0],
          [1, 0],
          [1, NaN],
          [0, 1],
        ],
        2,
      ),
    ).toThrow(TypeError);
  });
});

describe('resolveTileUrl', () => {
  test('fills the placeholders', () => {
    expect(resolveTileUrl('https://a.example.com/{z}/{x}/{y}.pbf', { z: 3, x: 4, y: 5 })).toBe(
      'https://a.example.com/3/4/5.pbf',
    );
  });

  test('picks from several templates the same way MapLibre does', () => {
    const templates = ['https://a.example.com/{z}/{x}/{y}.pbf', 'https://b.example.com/{z}/{x}/{y}.pbf'];

    expect(resolveTileUrl(templates, { z: 1, x: 0, y: 0 })).toBe('https://a.example.com/1/0/0.pbf');
    expect(resolveTileUrl(templates, { z: 1, x: 1, y: 0 })).toBe('https://b.example.com/1/1/0.pbf');
  });
});
