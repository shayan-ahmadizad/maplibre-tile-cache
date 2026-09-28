import type { PrefetchProgress, PrefetchResult, TileCoord } from './types';

export type CacheTileFn = (tile: TileCoord, signal?: AbortSignal) => Promise<'cached' | 'fetched'>;

type RunPrefetchOptions = {
  concurrency: number;
  signal?: AbortSignal;
  onProgress?: (progress: PrefetchProgress) => void;
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('The prefetch was aborted', 'AbortError');

/**
 * Runs `cacheTile` over `tiles` with at most `concurrency` requests in flight.
 *
 * A failed tile is recorded and the run carries on. One bad request on a flaky
 * connection shouldn't throw away the other few hundred. Aborting stops
 * scheduling and rejects with the signal's reason.
 */
export const runPrefetch = async (
  tiles: readonly TileCoord[],
  cacheTile: CacheTileFn,
  { concurrency, signal, onProgress }: RunPrefetchOptions,
): Promise<PrefetchResult> => {
  const progress: PrefetchProgress = { total: tiles.length, completed: 0, fetched: 0, cached: 0, failed: 0 };
  const errors: PrefetchResult['errors'] = [];
  let cursor = 0;

  const worker = async () => {
    while (cursor < tiles.length) {
      if (signal?.aborted) {
        throw abortReason(signal);
      }
      const tile = tiles[cursor++]!;
      try {
        const outcome = await cacheTile(tile, signal);
        progress[outcome] += 1;
      } catch (error) {
        if (signal?.aborted) {
          throw abortReason(signal);
        }
        progress.failed += 1;
        errors.push({ tile, error });
      }
      progress.completed += 1;
      onProgress?.({ ...progress });
    }
  };

  if (signal?.aborted) {
    throw abortReason(signal);
  }
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), tiles.length));
  await Promise.all(Array.from({ length: workerCount }, worker));

  return { ...progress, errors };
};
