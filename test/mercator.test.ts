import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tileForLngLat, webMercatorTileBounds, MAX_MERCATOR_LAT } from '../src/mercator.js'
import { CHART_SOURCES } from '../src/registry.js'

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

import { tilesInBbox, tileCountInBbox } from '../src/mercator.js'
import type { ChartSource } from '../src/types.js'

const xyz = (over: Partial<ChartSource> = {}): ChartSource => ({
  id: 's', title: 'S', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '',
  upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' }, ...over
})

test('tileCountInBbox counts the tile rectangle at each zoom', () => {
  // The whole world at zoom 0 is one tile; at zoom 1 it is four.
  assert.equal(tileCountInBbox(xyz(), [-179, -80, 179, 80], [0, 0]), 1)
  assert.equal(tileCountInBbox(xyz(), [-179, -80, 179, 80], [0, 1]), 5)
})

test('tilesInBbox enumerates exactly tileCountInBbox tiles', () => {
  const bbox: [number, number, number, number] = [-10, 40, 10, 55]
  const range: [number, number] = [4, 7]
  assert.equal(tilesInBbox(xyz(), bbox, range).length, tileCountInBbox(xyz(), bbox, range))
})

test('the zoom range clamps to the source min and max zoom', () => {
  const src = xyz({ minzoom: 5, maxzoom: 8 })
  const tiles = tilesInBbox(src, [-10, 40, 10, 55], [0, 20])
  assert.ok(tiles.every((t) => t.z >= 5 && t.z <= 8))
})

test('the bbox clips to the source bounds', () => {
  const bounded = xyz({ bounds: [0, 0, 5, 5] })
  const unbounded = xyz()
  const range: [number, number] = [6, 6]
  assert.ok(
    tileCountInBbox(bounded, [-20, -20, 20, 20], range) < tileCountInBbox(unbounded, [-20, -20, 20, 20], range)
  )
})

test('an antimeridian-crossing box is rejected (empty) in v2', () => {
  assert.deepEqual(tilesInBbox(xyz(), [170, -10, -170, 10], [3, 3]), [])
  assert.equal(tileCountInBbox(xyz(), [170, -10, -170, 10], [3, 3]), 0)
})

test('a non-finite or degenerate box yields nothing', () => {
  assert.equal(tileCountInBbox(xyz(), [Number.NaN, 0, 1, 1], [2, 2]), 0)
  assert.equal(tileCountInBbox(xyz(), [5, 5, 5, 5], [2, 2]), 0)
})

test('tileCountInBbox clamps a vector source to vectorMaxzoom even when asked for a higher zoom', () => {
  const basemap = CHART_SOURCES.find((s) => s.id === 'basemap')!
  // The basemap maxzoom is 20 but vectorMaxzoom is 14; a request for z0..16 must enumerate no tiles above 14.
  const wide = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 16])
  const at14 = tileCountInBbox(basemap, [-10, 40, 10, 55], [0, 14])
  assert.equal(wide, at14, 'the count clamps to vectorMaxzoom (14), so z15 and z16 add nothing')
})
