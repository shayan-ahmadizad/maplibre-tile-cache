import { describe, expect, test } from 'vitest';
import { isPbfUrl, stripCustomProtocol, toCustomProtocolUrl } from './urls';

const tileUrl = 'https://tiles.example.com/data/v3/14/10530/6446.pbf';
const glyphUrl = 'https://tiles.example.com/fonts/Noto Sans Regular/0-255.pbf';
const styleUrl = 'https://tiles.example.com/styles/basic/style.json';

describe('isPbfUrl', () => {
  test('matches tiles and glyph ranges', () => {
    expect(isPbfUrl(tileUrl)).toBe(true);
    expect(isPbfUrl(glyphUrl)).toBe(true);
    expect(isPbfUrl(`${tileUrl}?key=abc`)).toBe(true);
    expect(isPbfUrl(styleUrl)).toBe(false);
  });
});

describe('custom protocol URLs', () => {
  test('folds https into the custom protocol so MapLibre can parse the host', () => {
    expect(toCustomProtocolUrl('tilecache', tileUrl)).toBe('tilecache://tiles.example.com/data/v3/14/10530/6446.pbf');
    expect(stripCustomProtocol('tilecache', 'tilecache://tiles.example.com/data/v3/14/10530/6446.pbf')).toBe(tileUrl);
  });

  test('keeps plain http on a separate scheme', () => {
    const localTile = 'http://localhost:8080/data/v3/1/0/0.pbf';
    const protocolUrl = toCustomProtocolUrl('tilecache', localTile);

    expect(protocolUrl).toBe('tilecache+http://localhost:8080/data/v3/1/0/0.pbf');
    expect(stripCustomProtocol('tilecache', protocolUrl)).toBe(localTile);
  });

  test('leaves other URLs unchanged', () => {
    expect(toCustomProtocolUrl('tilecache', '/tiles/1/0/0.pbf')).toBe('/tiles/1/0/0.pbf');
    expect(stripCustomProtocol('tilecache', tileUrl)).toBe(tileUrl);
  });
});
