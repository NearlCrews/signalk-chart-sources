import type { ChartSource, LngLatBbox, MercatorBbox, TileEnumerationOptions, ZoomRange, ZXY } from './types.js'
import {
  assertLngLat,
  assertLngLatBbox,
  assertTileCoordinate,
  assertZoom,
  assertZoomRange,
  checkedSource,
  MAX_TILE_ZOOM,
  type PreparedSource,
  splitValidBbox
} from './validate.js'

// Keep ORIGIN and webMercatorTileBounds bit-exact with the Rust tile-cache container copy
// (upstream.rs), and change both together.
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
 * The smallest edge magnitude a real tile can produce, which is the tile size at MAX_TILE_ZOOM. Any
 * coordinate below this is floating-point residue from an edge that is mathematically zero, never a
 * genuine tile boundary. Derived rather than written as a literal so raising MAX_TILE_ZOOM moves it.
 */
export const MIN_TILE_EDGE_METERS: number = (2 * ORIGIN) / 2 ** MAX_TILE_ZOOM

/** Degrees to radians as one multiplication, the form Rust's f64::to_radians uses. */
const RADIANS_PER_DEGREE = Math.PI / 180

/**
 * Return the integer XYZ tile containing a finite longitude-latitude point.
 * Latitude clamps to the Web Mercator limit, and finite longitude clamps to an edge tile.
 *
 * Shares its formula and operation order with the Rust tile_for_lng_lat (geom.rs) but is not
 * bit-exact with it: tan and asinh come from different math libraries, so on a point within a few
 * ULPs of a tile boundary the two can pick neighboring tiles. A count from here and an enumeration
 * there can therefore differ by the odd boundary tile.
 *
 * @throws {RangeError} When a coordinate is not finite or the zoom is out of range.
 */
export function tileForLngLat(lng: number, lat: number, z: number): Readonly<{ x: number; y: number }> {
  assertLngLat(lng, lat)
  assertZoom(z)
  const n = 2 ** z
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const latRad = clampedLat * RADIANS_PER_DEGREE
  const xf = Math.floor(((lng + 180) / 360) * n)
  const yf = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  const max = n - 1
  return {
    x: Math.min(max, Math.max(0, xf)),
    y: Math.min(max, Math.max(0, yf))
  }
}

type TileRange = Readonly<{ z: number; x0: number; x1: number; y0: number; y1: number }>

export const DEFAULT_MAX_ENUMERATED_TILES = 1_000_000

/**
 * Intersect two boxes that do not cross the antimeridian, clamping latitude to plus or minus latLimit,
 * or return null when nothing is left.
 */
function intersectBboxes(left: LngLatBbox, right: LngLatBbox, latLimit: number): LngLatBbox | null {
  const west = Math.max(left[0], right[0])
  const south = Math.max(left[1], right[1], -latLimit)
  const east = Math.min(left[2], right[2])
  const north = Math.min(left[3], right[3], latLimit)
  return west < east && south < north ? [west, south, east, north] : null
}

const crossesAntimeridian = (box: LngLatBbox): boolean => box[0] > box[2]

/**
 * Split every box of a list that crosses the antimeridian, returning the list itself when none does,
 * so a list that is already split passes through without a copy. Only west > east crosses: a box of
 * zero width, which validation never accepts, stays whole rather than reading as a full wrap.
 */
function splitRegions(boxes: readonly LngLatBbox[]): readonly LngLatBbox[] {
  return boxes.some(crossesAntimeridian)
    ? boxes.flatMap((box) => (crossesAntimeridian(box) ? splitValidBbox(box) : [box]))
    : boxes
}

/**
 * Clip regions to a box, either of which may cross the antimeridian, dropping any region left empty.
 * Both are taken as valid: the tile helpers validate the box first, and the catalog's clipped lists
 * are validated as the catalog is built. The tile helpers clamp latitude to the Web Mercator limit,
 * and one that only needs to know whether anything is left stops at the first clip. The catalog
 * passes 90, clipping one region list to another without the projection's say.
 */
export function clipRegions(
  regions: readonly LngLatBbox[],
  bounds: LngLatBbox,
  latLimit: number = MAX_MERCATOR_LAT,
  maxClips: number = Number.POSITIVE_INFINITY
): LngLatBbox[] {
  const pieces = splitRegions(regions)
  const clips: LngLatBbox[] = []
  for (const outer of splitValidBbox(bounds)) {
    for (const piece of pieces) {
      const clip = intersectBboxes(outer, piece, latLimit)
      if (clip === null) continue
      clips.push(clip)
      if (clips.length >= maxClips) return clips
    }
  }
  return clips
}

/** The deepest zoom a source serves. vectorMaxzoom is validated to sit within its zoom range. */
const zoomCeiling = (source: ChartSource): number => source.vectorMaxzoom ?? source.maxzoom

/** Validate a zoom range and report whether it shares any zoom with those the source serves. */
function servesAnyZoom(source: ChartSource, zoomRange: ZoomRange): boolean {
  assertZoomRange(zoomRange)
  return zoomRange[0] <= zoomCeiling(source) && source.minzoom <= zoomRange[1]
}

type CoveredClips = Readonly<{ clips: readonly LngLatBbox[]; zmin: number; zmax: number }>

/**
 * The request box clipped to a source's regions, over the zooms both share, or null when either is
 * empty. Both inputs are validated first, and the zooms are settled before any clipping they make
 * unnecessary. maxClips stops the clipping early for a caller that only asks whether anything is left.
 */
function coveredClips(
  prepared: PreparedSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  maxClips?: number
): CoveredClips | null {
  const { source, regions } = prepared
  assertLngLatBbox(bbox)
  if (!servesAnyZoom(source, zoomRange)) return null
  const clips = clipRegions(regions, bbox, MAX_MERCATOR_LAT, maxClips)
  if (clips.length === 0) return null
  return { clips, zmin: Math.max(zoomRange[0], source.minzoom), zmax: Math.min(zoomRange[1], zoomCeiling(source)) }
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
      if (x0 === undefined || xEnd === undefined) continue
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
  // Already ordered by construction: byZoom holds zooms in the caller's ascending insertion order,
  // slabs walk sorted boundaries, and each slab's merged y-intervals flush in ascending order. The
  // exact-order enumeration tests pin this, so a regression cannot slip out silently.
  return out
}

function coveredRanges(source: ChartSource, bbox: LngLatBbox, zoomRange: ZoomRange): TileRange[] {
  const covered = coveredClips(checkedSource(source), bbox, zoomRange)
  if (covered === null) return []
  const ranges: TileRange[] = []
  for (let z = covered.zmin; z <= covered.zmax; z++) {
    for (const clip of covered.clips) ranges.push(tileRange(clip, z))
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
 * coverage regions are split and deduplicated.
 *
 * @throws {TypeError | RangeError} When the source definition is invalid, or when the box, the zoom
 * range, or the resulting total is out of range.
 */
export function tileCountInBbox(source: ChartSource, bbox: LngLatBbox, zoomRange: ZoomRange): number {
  return countRanges(coveredRanges(source, bbox, zoomRange))
}

/**
 * Report whether a source covers any tile of the box within the zoom range: the same answer as
 * tileCountInBbox(...) > 0, without building or counting ranges, and without the unsafe-total error a
 * huge box at a deep zoom raises there. Every clip yields at least one tile at every zoom it spans,
 * so a non-empty clip list and a non-empty zoom range are all it takes.
 *
 * @throws {TypeError | RangeError} When the source definition, the box, or the zoom range is invalid.
 */
export function coversBbox(source: ChartSource, bbox: LngLatBbox, zoomRange: ZoomRange): boolean {
  // One clip settles the answer, so the clipping stops at the first.
  return coveredClips(checkedSource(source), bbox, zoomRange, 1) !== null
}

/**
 * Report whether a point lies inside a source's coverage regions, or its bounds when it has no
 * coverage, or anywhere for a worldwide source. Region edges are inclusive, and a region crossing the
 * antimeridian is split there, so -180 and 180 both match an edge on that meridian. A finite point
 * outside the drawable range, longitude beyond [-180, 180] or latitude past MAX_MERCATOR_LAT, lies in
 * no tile and returns false rather than throwing.
 *
 * Without a zoom range the answer is about geography alone. With one, the range must also overlap the
 * zooms the source serves, exactly as coversBbox requires, so a route check at a harbor zoom does not
 * count a source whose tiles stop well short of it.
 *
 * @throws {TypeError | RangeError} When the source definition is invalid, a coordinate is not finite,
 * or a zoom range is given and invalid.
 */
export function coversPoint(source: ChartSource, lng: number, lat: number, zoomRange?: ZoomRange): boolean {
  const { source: checked, regions } = checkedSource(source)
  assertLngLat(lng, lat)
  if (zoomRange !== undefined && !servesAnyZoom(checked, zoomRange)) return false
  if (lng < -180 || lng > 180 || Math.abs(lat) > MAX_MERCATOR_LAT) return false
  // The two spellings of the antimeridian are one line, so a point on it lies in any region touching
  // either. The regions are already split there, so each runs west to east. Indexed, so this hot
  // per-point check allocates nothing.
  const antimeridian = Math.abs(lng) === 180
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index]
    if (region === undefined || lat < region[1] || lat > region[3]) continue
    if (antimeridian ? region[0] === -180 || region[2] === 180 : region[0] <= lng && lng <= region[2]) return true
  }
  return false
}

function* yieldRanges(ranges: readonly TileRange[]): Generator<ZXY, void, undefined> {
  for (const { z, x0, x1, y0, y1 } of ranges) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) yield { z, x, y }
    }
  }
}

function enumerableRanges(
  source: ChartSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  options: TileEnumerationOptions
): TileRange[] {
  // Check the caller's own limit before doing any work, so an unusable maxTiles reports itself
  // instead of being masked by an unsafe-total error from a large box.
  const limit = enumerationLimit(options)
  const ranges = coveredRanges(source, bbox, zoomRange)
  const total = countRanges(ranges)
  if (total > limit) throw new RangeError(`tile enumeration ${total} exceeds maxTiles ${limit}`)
  return ranges
}

/**
 * Lazily enumerate distinct covered tiles. Inputs are validated and the total is checked against
 * maxTiles when the call is made rather than when the generator is first advanced, so a rejected
 * request fails closed even for a caller that never iterates.
 *
 * @throws {TypeError | RangeError} When the source definition is invalid, when the box, the zoom
 * range, or maxTiles is out of range, or when the total exceeds maxTiles.
 */
export function iterateTilesInBbox(
  source: ChartSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  options: TileEnumerationOptions = {}
): Generator<ZXY, void, undefined> {
  return yieldRanges(enumerableRanges(source, bbox, zoomRange, options))
}

/**
 * Enumerate distinct covered tiles into an array, subject to a defensive maximum size. Fills the
 * array directly rather than draining the generator: this is the warming hot path, and iterator
 * suspend and resume per tile is measurable across a million-tile request.
 *
 * @throws {TypeError | RangeError} Under the same conditions as iterateTilesInBbox.
 */
export function tilesInBbox(
  source: ChartSource,
  bbox: LngLatBbox,
  zoomRange: ZoomRange,
  options: TileEnumerationOptions = {}
): ZXY[] {
  const tiles: ZXY[] = []
  for (const { z, x0, x1, y0, y1 } of enumerableRanges(source, bbox, zoomRange, options)) {
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) tiles.push({ z, x, y })
    }
  }
  return tiles
}
