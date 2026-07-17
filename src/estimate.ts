import { tileCountInBbox } from './mercator.js'
import { chartSourceById } from './registry.js'
import type { LngLatBbox, UpstreamTemplate, ZoomRange } from './types.js'

/** Conservative generic fallback when a source has no more specific first-download estimate. */
export const DEFAULT_TILE_BYTES = 512_000

/** Frozen first-download fallbacks keyed by upstream mode. A source-specific value takes priority. */
export const DEFAULT_TILE_BYTES_BY_MODE: Readonly<Record<UpstreamTemplate['mode'], number>> = Object.freeze({
  xyz: 512_000,
  wmts: 1_000_000,
  wms: 512_000,
  arcgis: 512_000,
  style: 750_000
})

function validatedAverage(id: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`average tile bytes for ${id} must be a positive safe integer`)
  }
  return value
}

/**
 * Return a conservative planning estimate for known sources and an inclusive zoom range.
 *
 * @throws {RangeError} When a source id is unknown, an average is not a positive safe integer, tile
 * inputs are invalid, or the result exceeds Number.MAX_SAFE_INTEGER.
 *
 * The consuming server must still enforce actual tile-count and transferred-byte limits because
 * compressed tile size varies and no average can be a mathematical upper bound.
 */
export function estimateBytes(
  sourceIds: readonly string[],
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  perSourceAvgBytes: Readonly<Record<string, number>>
): number {
  let total = 0
  for (const id of sourceIds) {
    const source = chartSourceById(id)
    if (!source) throw new RangeError(`unknown chart source: ${id}`)
    const tiles = tileCountInBbox(source, bbox, zoomRange)
    const measured = perSourceAvgBytes[id]
    const avg =
      measured === undefined
        ? (source.fallbackTileBytes ?? DEFAULT_TILE_BYTES_BY_MODE[source.upstream.mode] ?? DEFAULT_TILE_BYTES)
        : validatedAverage(id, measured)
    const sourceTotal = tiles * avg
    if (!Number.isSafeInteger(sourceTotal) || !Number.isSafeInteger(total + sourceTotal)) {
      throw new RangeError('byte estimate exceeds the safe integer limit')
    }
    total += sourceTotal
  }
  return total
}
