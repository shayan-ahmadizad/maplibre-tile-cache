/** Protobuf map assets: vector tiles and glyph ranges. */
const PBF_PATH = /\.pbf(?:\?|$)/i;

export const isPbfUrl = (url: string): boolean => PBF_PATH.test(url);

/** Plain-http tiles get their own scheme so the original scheme survives the round trip. */
export const insecureProtocol = (protocol: string): string => `${protocol}+http`;

/**
 * MapLibre and `new URL` parse `tilecache://https://host/path` with `https` as the
 * host, so the original scheme is folded into the custom one instead:
 *
 * - `https://host/path` → `tilecache://host/path`
 * - `http://host/path`  → `tilecache+http://host/path`
 *
 * Anything else (relative URLs, `data:`, already rewritten URLs) is returned as is.
 */
export const toCustomProtocolUrl = (protocol: string, url: string): string => {
  if (/^https:\/\//i.test(url)) {
    return `${protocol}://${url.slice('https://'.length)}`;
  }
  if (/^http:\/\//i.test(url)) {
    return `${insecureProtocol(protocol)}://${url.slice('http://'.length)}`;
  }
  return url;
};

export const stripCustomProtocol = (protocol: string, url: string): string => {
  const insecurePrefix = `${insecureProtocol(protocol)}://`;
  if (url.startsWith(insecurePrefix)) {
    return `http://${url.slice(insecurePrefix.length)}`;
  }
  const prefix = `${protocol}://`;
  if (url.startsWith(prefix)) {
    return `https://${url.slice(prefix.length)}`;
  }
  return url;
};

export const isCustomProtocolUrl = (protocol: string, url: string): boolean =>
  url.startsWith(`${protocol}://`) || url.startsWith(`${insecureProtocol(protocol)}://`);
