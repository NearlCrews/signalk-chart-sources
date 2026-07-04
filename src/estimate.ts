import type { Bbox, ZoomRange } from './types.js'
import { chartSourceById } from './registry.js'
import { tileCountInBbox } from './mercator.js'

/** Fallback per-tile size for a source never cached yet, so an estimate still gates a first download. */
export const DEFAULT_TILE_BYTES = 25_000

/**
 * The upper-bound byte estimate: sum over sourceIds of tileCountInBbox times the per-source average
 * (with the DEFAULT_TILE_BYTES fallback). Takes the average map, not a webapp CacheStats, so the
 * plugin can re-validate server-side without depending on the webapp. Unknown ids are skipped.
 */
export function estimateBytes (
  sourceIds: string[],
  bbox: Bbox,
  zoomRange: ZoomRange,
  perSourceAvgBytes: Record<string, number>
): number {
  let total = 0
  for (const id of sourceIds) {
    const source = chartSourceById(id)
    if (!source) continue
    const tiles = tileCountInBbox(source, bbox, zoomRange)
    const avg = perSourceAvgBytes[id] ?? DEFAULT_TILE_BYTES
    total += tiles * avg
  }
  return total
}
