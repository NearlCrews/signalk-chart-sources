import { tileCountInBbox } from './mercator.js'
import { chartSourceById } from './registry.js'
import type { ChartSource, LngLatBbox, UpstreamTemplate, ZoomRange } from './types.js'
import { assertSourceId } from './validate.js'

/** Frozen first-download fallbacks keyed by upstream mode. A source-specific value takes priority. */
export const DEFAULT_TILE_BYTES_BY_MODE: Readonly<Record<UpstreamTemplate['mode'], number>> = Object.freeze({
  xyz: 512_000,
  wmts: 1_000_000,
  wms: 512_000,
  arcgis: 512_000,
  style: 750_000
})

/**
 * Resolve a catalog id or a supplied source to the source to price. Only the id is checked here, not
 * the whole shape: the id is all that has to be trustworthy before it reaches the dedupe set and the
 * averages lookup, and `tileCountInBbox` fully validates the source a few lines later. Validating
 * twice doubled the cost for a source carrying coverage regions.
 */
function resolved(entry: string | ChartSource): ChartSource {
  if (typeof entry !== 'string') {
    assertSourceId((entry as { id?: unknown })?.id)
    return entry
  }
  const known = chartSourceById(entry)
  if (!known) throw new RangeError(`unknown chart source: ${entry}`)
  return known
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
 * @throws {TypeError | RangeError} When a source id is unknown or malformed, a supplied source is
 * invalid, an average is not a positive safe integer, tile inputs are invalid, or the result exceeds
 * Number.MAX_SAFE_INTEGER.
 *
 * The consuming server must still enforce actual tile-count and transferred-byte limits because
 * compressed tile size varies and no average can be a mathematical upper bound.
 */
export function estimateBytes(
  sources: readonly (string | ChartSource)[],
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  perSourceAvgBytes: Readonly<Record<string, number>>
): number {
  let total = 0
  const counted = new Set<string>()
  for (const entry of sources) {
    const source = resolved(entry)
    const id = source.id
    if (counted.has(id)) continue
    counted.add(id)
    const tiles = tileCountInBbox(source, bbox, zoomRange)
    // Own properties only. Callers are told to treat cache statistics as untrusted, so an inherited
    // or prototype-polluted entry must not silently stand in for a measured average.
    const measured = Object.hasOwn(perSourceAvgBytes, id) ? perSourceAvgBytes[id] : undefined
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
