import { tileCountInBbox } from './mercator.js'
import { chartSourceById } from './registry.js'
import type { LngLatBbox, UpstreamTemplate, ZoomRange } from './types.js'

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
 * Return a conservative planning estimate for known sources and an inclusive zoom range. Duplicate
 * source ids are counted once.
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
  for (const id of new Set(sourceIds)) {
    const source = chartSourceById(id)
    if (!source) throw new RangeError(`unknown chart source: ${id}`)
    const tiles = tileCountInBbox(source, bbox, zoomRange)
    // Own properties only. Callers are told to treat cache statistics as untrusted, so an inherited
    // or prototype-polluted entry must not silently stand in for a measured average.
    const measured = Object.hasOwn(perSourceAvgBytes, id) ? perSourceAvgBytes[id] : undefined
    const avg =
      measured === undefined
        ? (source.fallbackTileBytes ?? DEFAULT_TILE_BYTES_BY_MODE[source.upstream.mode])
        : validatedAverage(id, measured)
    const sourceTotal = tiles * avg
    if (!Number.isSafeInteger(sourceTotal) || !Number.isSafeInteger(total + sourceTotal)) {
      throw new RangeError('byte estimate exceeds the safe integer limit')
    }
    total += sourceTotal
  }
  return total
}
