import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_MAX_ENUMERATED_TILES,
  iterateTilesInBbox,
  MAX_MERCATOR_LAT,
  tileCountInBbox,
  tileForLngLat,
  tilesInBbox,
  webMercatorTileBounds
} from '../src/mercator.js'
import type { ChartSource, LngLatBbox, ZoomRange } from '../src/types.js'
import { makeSource, src } from './fixtures.js'

const WORLD: LngLatBbox = [-180, -MAX_MERCATOR_LAT, 180, MAX_MERCATOR_LAT]

test('tileForLngLat returns 0,0 at zoom 0', () => {
  assert.deepEqual(tileForLngLat(0, 0, 0), { x: 0, y: 0 })
  assert.deepEqual(tileForLngLat(179, -80, 0), { x: 0, y: 0 })
})

test('tileForLngLat floors to the slippy tile containing the point', () => {
  // null island at zoom 1 is the bottom-right of the top-left quadrant boundary: x=1, y=1.
  assert.deepEqual(tileForLngLat(0, 0, 1), { x: 1, y: 1 })
  // far north-west corner is tile 0,0; far south-east corner is tile 3,3 at zoom 2.
  assert.deepEqual(tileForLngLat(-180, MAX_MERCATOR_LAT, 2), { x: 0, y: 0 })
  assert.deepEqual(tileForLngLat(179.999, -MAX_MERCATOR_LAT, 2), { x: 3, y: 3 })
})

test('tileForLngLat clamps latitude to the Mercator limit and stays in range', () => {
  const beyond = tileForLngLat(0, 89, 4)
  const atLimit = tileForLngLat(0, MAX_MERCATOR_LAT, 4)
  assert.deepEqual(beyond, atLimit, 'a latitude beyond the limit clamps to the limit tile')
  assert.ok(beyond.y >= 0 && beyond.y < 2 ** 4)
})

test('an out-of-range longitude lands on the edge tile via the index clamp', () => {
  // Longitude has no named clamp like MAX_MERCATOR_LAT; the final tile-index clamp bounds it.
  assert.deepEqual(tileForLngLat(190, 0, 2), { x: 3, y: 2 })
  assert.deepEqual(tileForLngLat(-190, 0, 2), { x: 0, y: 2 })
})

test('the inverse lands inside its own forward tile bounds', () => {
  const z = 9
  const lng = -122.4194
  const lat = 37.7749
  const { x, y } = tileForLngLat(lng, lat, z)
  const [minX, minY, maxX, maxY] = webMercatorTileBounds(z, x, y)
  const mx = (lng / 180) * 20037508.342789244
  const latRad = (lat * Math.PI) / 180
  const my = (Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) * 20037508.342789244
  assert.ok(mx >= minX && mx <= maxX, 'x falls within the tile')
  assert.ok(my >= minY && my <= maxY, 'y falls within the tile')
})

test('webMercatorTileBounds returns the full 3857 extent at z0,0,0', () => {
  // The single zoom-0 tile spans the whole Web Mercator square, so its bounds are +/- ORIGIN.
  assert.deepEqual(
    webMercatorTileBounds(0, 0, 0),
    [-20037508.342789244, -20037508.342789244, 20037508.342789244, 20037508.342789244]
  )
})

test('tileCountInBbox counts the tile rectangle at each zoom', () => {
  // A covering box falls in the single z0 tile; over zoom 0 to 1 it adds the four z1 tiles.
  assert.equal(tileCountInBbox(makeSource(), [-179, -80, 179, 80], [0, 0]), 1)
  assert.equal(tileCountInBbox(makeSource(), [-179, -80, 179, 80], [0, 1]), 5)
})

test('tilesInBbox yields the exact z/x/y tiles, not just the right count', () => {
  // Zoom 0 has one tile for any covering box.
  assert.deepEqual(tilesInBbox(makeSource(), [-10, -10, 10, 10], [0, 0]), [{ z: 0, x: 0, y: 0 }])
  // A small box in the northeast quadrant at zoom 1 is the top-right tile: x 1, y 0.
  assert.deepEqual(tilesInBbox(makeSource(), [1, 1, 11, 11], [1, 1]), [{ z: 1, x: 1, y: 0 }])
})

test('tilesInBbox enumerates exactly tileCountInBbox tiles', () => {
  const bbox: LngLatBbox = [-10, 40, 10, 55]
  const range: ZoomRange = [4, 7]
  assert.equal(tilesInBbox(makeSource(), bbox, range).length, tileCountInBbox(makeSource(), bbox, range))
})

test('the zoom range clamps to the source min and max zoom', () => {
  const src = makeSource({ minzoom: 5, maxzoom: 8 })
  const tiles = tilesInBbox(src, [-10, 40, 10, 55], [0, 20])
  assert.ok(tiles.every((t) => t.z >= 5 && t.z <= 8))
})

test('the bbox clips to the source bounds', () => {
  const bounded = makeSource({ bounds: [0, 0, 5, 5] })
  const unbounded = makeSource()
  const range: ZoomRange = [6, 6]
  const request: LngLatBbox = [-20, -20, 20, 20]
  const clipped = tilesInBbox(bounded, request, range)
  assert.ok(clipped.length > 0, 'clipping must not empty the result')
  assert.ok(clipped.length < tileCountInBbox(unbounded, request, range))
  // Every returned tile must actually lie inside the declared bounds, which a count comparison alone
  // would not catch if the clip kept the wrong rectangle.
  const insideBounds = tilesInBbox(makeSource(), [0, 0, 5, 5], range)
  assert.deepEqual(clipped, insideBounds)
})

test('an antimeridian-crossing box splits across the east and west edge without duplicates', () => {
  const tiles = tilesInBbox(makeSource(), [170, -10, -170, 10], [3, 3])
  assert.deepEqual(tiles, [
    { z: 3, x: 0, y: 3 },
    { z: 3, x: 0, y: 4 },
    { z: 3, x: 7, y: 3 },
    { z: 3, x: 7, y: 4 }
  ])
  assert.equal(tileCountInBbox(makeSource(), [170, -10, -170, 10], [3, 3]), tiles.length)
  assert.equal(tileCountInBbox(makeSource(), [170, -10, -170, 10], [0, 0]), 1)
})

test('a non-finite or degenerate box fails explicitly', () => {
  assert.throws(() => tileCountInBbox(makeSource(), [Number.NaN, 0, 1, 1], [2, 2]), RangeError)
  assert.throws(() => tileCountInBbox(makeSource(), [5, 5, 5, 5], [2, 2]), RangeError)
  assert.throws(() => tilesInBbox(makeSource(), [-181, 0, 1, 1], [2, 2]), RangeError)
  assert.throws(() => tileCountInBbox(makeSource(), [180, -1, -180, 1], [2, 2]), /non-zero area/)
  assert.throws(() => tilesInBbox(makeSource(), [180, -1, -180, 1], [2, 2]), /non-zero area/)
  assert.throws(() => [...iterateTilesInBbox(makeSource(), [180, -1, -180, 1], [2, 2])], /non-zero area/)
})

test('bbox edges are inclusive for conservative warming at exact tile boundaries', () => {
  assert.deepEqual(tilesInBbox(makeSource(), [-180, 0, 0, MAX_MERCATOR_LAT], [1, 1]), [
    { z: 1, x: 0, y: 0 },
    { z: 1, x: 0, y: 1 },
    { z: 1, x: 1, y: 0 },
    { z: 1, x: 1, y: 1 }
  ])
})

test('boundary inclusivity is directional: the east and south edges take in the neighboring tile', () => {
  // At z1 the tile boundaries are lng 0 and lat 0. Flooring always steps to the higher tile index,
  // so a box whose east or south edge sits on a boundary reaches the far tile, while one whose west
  // or north edge sits there does not. Pinned because the behavior reads as symmetric and is not.
  const axis = (bbox: LngLatBbox, key: 'x' | 'y'): number[] =>
    [...new Set(tilesInBbox(makeSource(), bbox, [1, 1]).map((tile) => tile[key]))].sort()

  assert.deepEqual(axis([-10, -10, 0, 10], 'x'), [0, 1], 'an east edge on lng 0 includes the eastern tile')
  assert.deepEqual(axis([0, -10, 10, 10], 'x'), [1], 'a west edge on lng 0 excludes the western tile')
  assert.deepEqual(axis([-10, 0, 10, 10], 'y'), [0, 1], 'a south edge on lat 0 includes the southern tile')
  assert.deepEqual(axis([-10, -10, 10, 0], 'y'), [1], 'a north edge on lat 0 excludes the northern tile')
})

test('a zero-width box is degenerate rather than a full antimeridian wrap', () => {
  // west === east has no longitude span. Reading it through the west > east wrap arm would turn a
  // caller's degenerate request into worldwide coverage.
  assert.throws(() => tileCountInBbox(makeSource(), [10, 0, 10, 10], [2, 2]), /non-zero area/)
  assert.throws(() => tilesInBbox(makeSource(), [-45, -5, -45, 5], [3, 3]), /non-zero area/)
})

test('maxTiles is validated at call time, before any counting work', () => {
  for (const maxTiles of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => tilesInBbox(makeSource(), [-1, -1, 1, 1], [1, 1], { maxTiles }), /maxTiles must be a positive/)
  }
  // A box whose count would overflow must still report the unusable maxTiles, not the overflow.
  assert.throws(() => tilesInBbox(makeSource(), WORLD, [30, 30], { maxTiles: -1 }), /maxTiles must be a positive/)
})

test('iterateTilesInBbox rejects bad input when it is called, not when it is first advanced', () => {
  // A caller that builds an iterator and abandons it must still get the rejection, so the fail-closed
  // contract does not depend on the consumer choosing to iterate.
  const invalid = { ...makeSource(), id: 'NOT A VALID ID' } as unknown as ChartSource
  assert.throws(() => iterateTilesInBbox(invalid, [-1, -1, 1, 1], [1, 1]), TypeError)
  assert.throws(() => iterateTilesInBbox(makeSource(), [5, 5, 5, 5], [1, 1]), {
    name: 'RangeError',
    message: /non-zero area/
  })
  assert.throws(() => iterateTilesInBbox(makeSource(), [-1, -1, 1, 1], [1, 1], { maxTiles: 0 }), RangeError)
})

test('coverage regions separated by a gap keep the gap instead of merging across it', () => {
  // Exercises the split arm of the y-interval merge. Without it the two bands would fuse and every
  // tile in the empty latitude gap would be warmed.
  const source = makeSource({
    coverage: [
      [0, 0, 10, 5],
      [0, 40, 10, 50]
    ]
  })
  const tiles = tilesInBbox(source, [-5, -5, 15, 55], [5, 5])
  assert.ok(tiles.length > 0)
  const rows = [...new Set(tiles.map((tile) => tile.y))].sort((a, b) => a - b)
  const gaps = rows.filter((row, index) => index > 0 && row !== (rows[index - 1] ?? row) + 1)
  assert.equal(gaps.length, 1, `expected one gap between the two bands, got rows ${rows.join(',')}`)
  // The southern band and the northern band must both be present, and nothing between them.
  const southern = tilesInBbox(makeSource({ coverage: [[0, 0, 10, 5]] }), [-5, -5, 15, 55], [5, 5])
  const northern = tilesInBbox(makeSource({ coverage: [[0, 40, 10, 50]] }), [-5, -5, 15, 55], [5, 5])
  assert.equal(tiles.length, southern.length + northern.length)
})

test('a tile total beyond the safe integer limit is rejected rather than silently rounded', () => {
  // 2^30 by 2^30 tiles is 2^60, far past Number.MAX_SAFE_INTEGER, so the sum loses precision.
  assert.throws(() => tileCountInBbox(makeSource({ maxzoom: 30 }), WORLD, [30, 30]), /safe integer limit/)
  assert.throws(() => tileCountInBbox(makeSource({ maxzoom: 30 }), WORLD, [0, 30]), /safe integer limit/)
})

test('zoom validation covers the ceiling, the type, and the range shape', () => {
  const source = makeSource()
  const bbox: LngLatBbox = [-1, -1, 1, 1]
  assert.throws(() => tileCountInBbox(source, bbox, [0, 31]), /between 0 and 30/)
  assert.throws(() => tileForLngLat(0, 0, 31), /between 0 and 30/)
  assert.throws(() => tileCountInBbox(source, bbox, ['0', 1] as unknown as ZoomRange), /between 0 and 30/)
  assert.throws(() => tileCountInBbox(source, bbox, [0] as unknown as ZoomRange), /exactly two values/)
  assert.throws(() => tileCountInBbox(source, bbox, [0, 1, 2] as unknown as ZoomRange), /exactly two values/)
  assert.throws(() => tileCountInBbox(source, bbox, Array(2) as unknown as ZoomRange), /exactly two values/)
})

test('overlapping coverage regions stay deduplicated across a multi-zoom range', () => {
  // Exercises the disjoint-range merge with regions that genuinely overlap rather than abut.
  const source = makeSource({
    coverage: [
      [-10, -10, 10, 10],
      [0, 0, 20, 20],
      [-5, -5, 5, 25]
    ]
  })
  const request: LngLatBbox = [-30, -30, 30, 30]
  const range: ZoomRange = [3, 7]
  const tiles = tilesInBbox(source, request, range, { maxTiles: 200_000 })
  const keys = new Set(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`))
  assert.equal(keys.size, tiles.length, 'the merge must not emit a tile twice')
  assert.equal(tileCountInBbox(source, request, range), tiles.length, 'the count must match the enumeration')

  // The union of the three regions, rasterized independently, is the ground truth.
  const expected = new Set<string>()
  for (const box of source.coverage ?? []) {
    for (const tile of tilesInBbox(makeSource({ coverage: [box] }), request, range, { maxTiles: 200_000 })) {
      expected.add(`${tile.z}/${tile.x}/${tile.y}`)
    }
  }
  assert.deepEqual([...keys].sort(), [...expected].sort())
})

test('tileCountInBbox clamps a vector source to vectorMaxzoom even when asked for a higher zoom', () => {
  const basemap = src('basemap')
  // The basemap maxzoom is 20 but vectorMaxzoom is 14; a request for z0..16 must enumerate no tiles above 14.
  const wide = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 16])
  const at14 = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 14])
  assert.equal(wide, at14, 'the count clamps to vectorMaxzoom (14), so z15 and z16 add nothing')
})

test('tile math rejects non-finite coordinates and invalid zooms', () => {
  assert.throws(() => tileForLngLat(Number.NaN, 0, 1), RangeError)
  assert.throws(() => tileForLngLat(0, Number.POSITIVE_INFINITY, 1), RangeError)
  assert.throws(() => tileForLngLat(0, 0, 1.5), RangeError)
  assert.throws(() => tileForLngLat(0, 0, -1), RangeError)
  assert.throws(() => webMercatorTileBounds(1, 2, 0), RangeError)
  assert.throws(() => tileCountInBbox(makeSource(), [-1, -1, 1, 1], [3, 2]), {
    name: 'RangeError',
    message: /must not exceed/
  })
})

test('enumeration fails before allocating an unsafe array and supports lazy iteration', () => {
  // Pin the exported default and match it in the message, so the runtime limit cannot diverge from
  // the constant's advertised value.
  assert.equal(DEFAULT_MAX_ENUMERATED_TILES, 1_000_000)
  assert.equal(tileCountInBbox(makeSource(), WORLD, [16, 16]), 4_294_967_296)
  assert.throws(
    () => tilesInBbox(makeSource(), WORLD, [16, 16]),
    new RegExp(`exceeds maxTiles ${DEFAULT_MAX_ENUMERATED_TILES}$`)
  )
  assert.deepEqual(
    [...iterateTilesInBbox(makeSource(), [-10, -10, 10, 10], [1, 1], { maxTiles: 10 })],
    tilesInBbox(makeSource(), [-10, -10, 10, 10], [1, 1])
  )
})

test('disjoint source coverage clips, merges, and deduplicates tile ranges', () => {
  const source = makeSource({
    bounds: [-180, -20, 180, 20],
    coverage: [
      [170, -10, 180, 10],
      [-180, -10, -170, 10]
    ]
  })
  assert.equal(tileCountInBbox(source, [160, -15, -160, 15], [0, 0]), 1)
  assert.deepEqual([...new Set(tilesInBbox(source, [160, -15, -160, 15], [2, 2]).map(({ x }) => x))], [0, 3])
})

test('deterministic bbox samples preserve count, uniqueness, and coordinate invariants', () => {
  let seed = 0x5eed1234
  const random = (): number => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  for (let sample = 0; sample < 100; sample++) {
    const west = -179 + random() * 340
    const south = -80 + random() * 140
    const bbox: LngLatBbox = [
      west,
      south,
      Math.min(179, west + 0.1 + random() * 10),
      Math.min(84, south + 0.1 + random() * 10)
    ]
    const z = Math.floor(random() * 9)
    const tiles = tilesInBbox(makeSource(), bbox, [z, z], { maxTiles: 20_000 })
    assert.equal(tiles.length, tileCountInBbox(makeSource(), bbox, [z, z]))
    assert.equal(new Set(tiles.map(({ z, x, y }) => `${z}/${x}/${y}`)).size, tiles.length)
    assert.ok(
      tiles.every(
        ({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z
      )
    )
  }
})
