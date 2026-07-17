import type { ChartSource, LngLatBbox, MercatorBbox, TileEnumerationOptions, ZoomRange } from './types.js'
import {
  assertFiniteNumber,
  assertLngLatBbox,
  assertTileCoordinate,
  assertZoom,
  assertZoomRange,
  validateChartSource
} from './validate.js'

// Keep this formula and constant bit-exact with the Rust tile-cache container copy.
const ORIGIN = 20037508.342789244

/** Return EPSG:3857 bounds for a valid XYZ tile, or throw RangeError for invalid coordinates. */
export function webMercatorTileBounds(z: number, x: number, y: number): MercatorBbox {
  assertTileCoordinate(z, x, y)
  const size = (2 * ORIGIN) / 2 ** z
  const minX = -ORIGIN + x * size
  const maxX = minX + size
  const maxY = ORIGIN - y * size
  const minY = maxY - size
  return [minX, minY, maxX, maxY]
}

export const MAX_MERCATOR_LAT = 85.0511287798066

/**
 * Return the integer XYZ tile containing a finite longitude-latitude point.
 * Latitude clamps to the Web Mercator limit, and finite longitude clamps to an edge tile.
 */
export function tileForLngLat(lng: number, lat: number, z: number): { x: number; y: number } {
  assertFiniteNumber(lng, 'longitude')
  assertFiniteNumber(lat, 'latitude')
  assertZoom(z)
  const n = 2 ** z
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const latRad = (clampedLat * Math.PI) / 180
  const xf = Math.floor(((lng + 180) / 360) * n)
  const yf = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  const max = n - 1
  return {
    x: Math.min(max, Math.max(0, xf)),
    y: Math.min(max, Math.max(0, yf))
  }
}

export type ZXY = Readonly<{ z: number; x: number; y: number }>

type TileRange = Readonly<{ z: number; x0: number; x1: number; y0: number; y1: number }>

export const DEFAULT_MAX_ENUMERATED_TILES = 1_000_000

function splitBbox(bbox: LngLatBbox): LngLatBbox[] {
  assertLngLatBbox(bbox)
  const [west, south, east, north] = bbox
  if (west < east) return [[west, south, east, north]]
  return [
    [west, south, 180, north],
    [-180, south, east, north]
  ]
}

function intersectBboxes(left: LngLatBbox, right: LngLatBbox): LngLatBbox | null {
  const west = Math.max(left[0], right[0])
  const south = Math.max(left[1], right[1], -MAX_MERCATOR_LAT)
  const east = Math.min(left[2], right[2])
  const north = Math.min(left[3], right[3], MAX_MERCATOR_LAT)
  return west < east && south < north ? [west, south, east, north] : null
}

function clipBboxes(source: ChartSource, bbox: LngLatBbox): LngLatBbox[] {
  const requested = splitBbox(bbox)
  const coverage = source.coverage ?? (source.bounds ? [source.bounds] : [[-180, -90, 180, 90] as const])
  const sourceBoxes = coverage.flatMap(splitBbox)
  const intersections: LngLatBbox[] = []
  for (const requestBox of requested) {
    for (const sourceBox of sourceBoxes) {
      const intersection = intersectBboxes(requestBox, sourceBox)
      if (intersection) intersections.push(intersection)
    }
  }
  return intersections
}

function zoomBounds(source: ChartSource, zoomRange: ZoomRange): ZoomRange {
  assertZoomRange(zoomRange)
  const [zmin, zmax] = zoomRange
  return [Math.max(zmin, source.minzoom), Math.min(zmax, source.maxzoom, source.vectorMaxzoom ?? source.maxzoom)]
}

function tileRange(clip: LngLatBbox, z: number): TileRange {
  const [west, south, east, north] = clip
  const topLeft = tileForLngLat(west, north, z)
  const bottomRight = tileForLngLat(east, south, z)
  return { z, x0: topLeft.x, x1: bottomRight.x, y0: topLeft.y, y1: bottomRight.y }
}

/** Convert possibly overlapping rectangles into disjoint x slabs with merged y intervals. */
function disjointRanges(ranges: readonly TileRange[]): TileRange[] {
  const byZoom = new Map<number, TileRange[]>()
  for (const range of ranges) {
    const list = byZoom.get(range.z) ?? []
    list.push(range)
    byZoom.set(range.z, list)
  }

  const out: TileRange[] = []
  for (const [z, zoomRanges] of byZoom) {
    const boundaries = [...new Set(zoomRanges.flatMap((range) => [range.x0, range.x1 + 1]))].sort((a, b) => a - b)
    for (let i = 0; i < boundaries.length - 1; i++) {
      const x0 = boundaries[i]
      const xEnd = boundaries[i + 1]
      if (x0 === undefined || xEnd === undefined || x0 >= xEnd) continue
      const intervals = zoomRanges
        .filter((range) => range.x0 <= x0 && range.x1 >= xEnd - 1)
        .map((range) => [range.y0, range.y1] as const)
        .sort((a, b) => a[0] - b[0])
      let current: readonly [number, number] | undefined
      for (const interval of intervals) {
        if (!current) {
          current = interval
        } else if (interval[0] <= current[1] + 1) {
          current = [current[0], Math.max(current[1], interval[1])]
        } else {
          out.push({ z, x0, x1: xEnd - 1, y0: current[0], y1: current[1] })
          current = interval
        }
      }
      if (current) out.push({ z, x0, x1: xEnd - 1, y0: current[0], y1: current[1] })
    }
  }
  return out.sort((a, b) => a.z - b.z || a.x0 - b.x0 || a.y0 - b.y0)
}

function coveredRanges(source: ChartSource, bbox: LngLatBbox, zoomRange: ZoomRange): TileRange[] {
  validateChartSource(source)
  const clips = clipBboxes(source, bbox)
  const [zmin, zmax] = zoomBounds(source, zoomRange)
  if (zmin > zmax || clips.length === 0) return []
  const ranges: TileRange[] = []
  for (let z = zmin; z <= zmax; z++) {
    for (const clip of clips) ranges.push(tileRange(clip, z))
  }
  return disjointRanges(ranges)
}

function countRanges(ranges: readonly TileRange[]): number {
  let count = 0
  for (const { x0, x1, y0, y1 } of ranges) {
    count += (x1 - x0 + 1) * (y1 - y0 + 1)
    if (!Number.isSafeInteger(count)) throw new RangeError('tile count exceeds the safe integer limit')
  }
  return count
}

function enumerationLimit(options: TileEnumerationOptions): number {
  const limit = options.maxTiles ?? DEFAULT_MAX_ENUMERATED_TILES
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError('maxTiles must be a positive safe integer')
  }
  return limit
}

/**
 * Count distinct covered tiles without allocating the tile list. Antimeridian boxes and overlapping
 * coverage regions are split and deduplicated. Invalid inputs and unsafe totals throw RangeError.
 */
export function tileCountInBbox(source: ChartSource, bbox: LngLatBbox, zoomRange: ZoomRange): number {
  return countRanges(coveredRanges(source, bbox, zoomRange))
}

/**
 * Lazily enumerate distinct covered tiles. The full count is validated against maxTiles before the
 * first value is yielded.
 */
export function* iterateTilesInBbox(
  source: ChartSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  options: TileEnumerationOptions = {}
): Generator<ZXY, void, undefined> {
  const ranges = coveredRanges(source, bbox, zoomRange)
  const total = countRanges(ranges)
  const limit = enumerationLimit(options)
  if (total > limit) throw new RangeError(`tile enumeration ${total} exceeds maxTiles ${limit}`)
  for (const { z, x0, x1, y0, y1 } of ranges) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) yield { z, x, y }
    }
  }
}

/** Enumerate distinct covered tiles into an array, subject to a defensive maximum size. */
export function tilesInBbox(
  source: ChartSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  options: TileEnumerationOptions = {}
): ZXY[] {
  return [...iterateTilesInBbox(source, bbox, zoomRange, options)]
}
