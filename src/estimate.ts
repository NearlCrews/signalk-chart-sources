import { countCoveredTiles } from './mercator.js'
import { chartSourceById } from './registry.js'
import type { ChartSource, LngLatBbox, UpstreamTemplate, ZoomRange } from './types.js'
import {
  assertRecord,
  checkedBbox,
  checkedSource,
  checkedZoomRange,
  describeValue,
  ownValue,
  type PreparedSource
} from './validate.js'

/** Frozen first-download fallbacks keyed by upstream mode. A source-specific value takes priority. */
export const DEFAULT_TILE_BYTES_BY_MODE: Readonly<Record<UpstreamTemplate['mode'], number>> = Object.freeze({
  xyz: 512_000,
  wmts: 1_000_000,
  wms: 512_000,
  arcgis: 512_000,
  style: 750_000
})

/**
 * Resolve a catalog id or a supplied source to the prepared snapshot to price. A supplied source is
 * checked in full here, before its id reaches the dedupe set, so an invalid entry cannot hide behind
 * an earlier one that shares its id. Every later read, the tile count included, uses the snapshot.
 */
function resolved(entry: string | ChartSource): PreparedSource {
  if (typeof entry !== 'string') return checkedSource(entry)
  const known = chartSourceById(entry)
  if (!known) throw new RangeError(`unknown chart source: ${describeValue(entry)}`)
  return checkedSource(known)
}

function validatedAverage(id: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`average tile bytes for ${id} must be a positive safe integer`)
  }
  return value
}

/**
 * Return a conservative planning estimate for an inclusive zoom range. Each entry is either a
 * built-in catalog id or a whole `ChartSource`, so a consumer can estimate a source it defined
 * itself without registering it. Entries resolving to the same id are counted once, the first
 * occurrence winning.
 *
 * The consuming server must still enforce actual tile-count and transferred-byte limits because
 * compressed tile size varies and no average can be a mathematical upper bound.
 *
 * @throws {TypeError | RangeError} When a source id is unknown or malformed, a supplied source is
 * invalid, an average is not a positive safe integer, tile inputs are invalid, or the result exceeds
 * Number.MAX_SAFE_INTEGER.
 */
export function estimateBytes(
  sources: readonly (string | ChartSource)[],
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  perSourceAvgBytes: Readonly<Record<string, number>>
): number {
  // Every input is checked up front, so an empty or fully deduplicated list still fails closed on a
  // malformed box, zoom range, or averages table rather than quietly pricing nothing. Every source is
  // counted over the one checked copy of each.
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array')
  const box = checkedBbox(bbox)
  const zooms = checkedZoomRange(zoomRange)
  assertRecord(perSourceAvgBytes, 'perSourceAvgBytes')
  let total = 0
  const counted = new Set<string>()
  for (const entry of sources) {
    const prepared = resolved(entry)
    const { source } = prepared
    const id = source.id
    if (counted.has(id)) continue
    counted.add(id)
    const tiles = countCoveredTiles(prepared, box, zooms)
    // Callers are told to treat cache statistics as untrusted, so an inherited or prototype-polluted
    // entry must not silently stand in for a measured average.
    const measured = ownValue(perSourceAvgBytes, id)
    const avg =
      measured === undefined
        ? (source.fallbackTileBytes ?? DEFAULT_TILE_BYTES_BY_MODE[source.upstream.mode])
        : validatedAverage(id, measured)
    const sourceTotal = tiles * avg
    const nextTotal = total + sourceTotal
    if (!Number.isSafeInteger(sourceTotal) || !Number.isSafeInteger(nextTotal)) {
      throw new RangeError('byte estimate exceeds the safe integer limit')
    }
    total = nextTotal
  }
  return total
}
