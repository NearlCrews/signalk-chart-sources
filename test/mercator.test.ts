import test from 'node:test'
import assert from 'node:assert/strict'
import { webMercatorTileBounds } from '../src/mercator.js'

const ORIGIN = 20037508.342789244

test('z0 single tile covers the whole web-mercator extent', () => {
  assert.deepEqual(webMercatorTileBounds(0, 0, 0), [-ORIGIN, -ORIGIN, ORIGIN, ORIGIN])
})

test('z1 top-left tile is the upper-left quadrant', () => {
  const [minX, minY, maxX, maxY] = webMercatorTileBounds(1, 0, 0)
  assert.equal(minX, -ORIGIN)
  assert.equal(maxX, 0)
  assert.equal(maxY, ORIGIN)
  assert.equal(minY, 0)
})

test('y increases downward, so the top tile sits above the bottom tile', () => {
  const top = webMercatorTileBounds(1, 0, 0)
  const bottom = webMercatorTileBounds(1, 0, 1)
  assert.ok(top[3] > bottom[3])
  assert.equal(top[1], bottom[3]) // the top tile's minY meets the bottom tile's maxY
})

test('a known z2 tile matches a precomputed bbox within tolerance', () => {
  const [minX, minY, maxX, maxY] = webMercatorTileBounds(2, 1, 1)
  const half = ORIGIN
  const size = (2 * half) / 4
  assert.ok(Math.abs(minX - (-half + size)) < 1e-6)
  assert.ok(Math.abs(maxX - 0) < 1e-6)
  assert.ok(Math.abs(maxY - (half - size)) < 1e-6)
  assert.ok(Math.abs(minY - 0) < 1e-6)
})
