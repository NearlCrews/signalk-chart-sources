import { CHART_SOURCES } from './registry.js'
import { tileCountInBbox } from './mercator.js'

/** Fallback per-tile size for a source never cached yet, so an estimate still gates a first download. */
export const DEFAULT_TILE_BYTES = 25_000

const byId = new Map(CHART_SOURCES.map((s) => [s.id, s]))

/**
 * The upper-bound byte estimate: sum over sourceIds of tileCountInBbox times the per-source average
 * (with the DEFAULT_TILE_BYTES fallback). Takes the average map, not a webapp CacheStats, so the
 * plugin can re-validate server-side without depending on the webapp. Unknown ids are skipped.
 */
export function estimateBytes (
  sourceIds: string[],
  bbox: [number, number, number, number],
  zoomRange: [number, number],
  perSourceAvgBytes: Record<string, number>
): number {
  let total = 0
  for (const id of sourceIds) {
    const source = byId.get(id)
    if (!source) continue
    const tiles = tileCountInBbox(source, bbox, zoomRange)
    const avg = perSourceAvgBytes[id] ?? DEFAULT_TILE_BYTES
    total += tiles * avg
  }
  return total
}
