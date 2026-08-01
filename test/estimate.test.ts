import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TILE_BYTES_BY_MODE, estimateBytes } from '../src/estimate.js'
import { tileCountInBbox } from '../src/mercator.js'
import { chartSourceById } from '../src/registry.js'
import type { LngLatBbox } from '../src/types.js'

const BBOX: LngLatBbox = [-1, -1, 1, 1]
const SAN_FRANCISCO: LngLatBbox = [-122.5, 37.5, -122.0, 38.0]

// A typo'd id must fail the test, not silently return undefined, so lookups assert.
const src = (id: string) => {
  const source = chartSourceById(id)
  assert.ok(source, `${id} must be in the catalog`)
  return source
}

test('the exported fallback constants hold their documented values', () => {
  // These are part of the published contract and estimateBytes never reaches them for a catalog
  // source, so nothing else would notice a value changing.
  assert.deepEqual(DEFAULT_TILE_BYTES_BY_MODE, {
    xyz: 512_000,
    wmts: 1_000_000,
    wms: 512_000,
    arcgis: 512_000,
    style: 750_000
  })
  assert.ok(Object.isFrozen(DEFAULT_TILE_BYTES_BY_MODE))
})

test('estimateBytes sums tileCount times the per-source average', () => {
  const seamark = src('seamark')
  // Assert the exact product. A divisibility check passes for any multiple, including a wrong count.
  const tiles = tileCountInBbox(seamark, BBOX, [6, 6])
  assert.ok(tiles > 0)
  assert.equal(estimateBytes(['seamark'], BBOX, [6, 6], { seamark: 100 }), tiles * 100)
})

test('estimateBytes falls back to the source fallbackTileBytes for an uncached source', () => {
  const seamark = src('seamark')
  const fallback = seamark.fallbackTileBytes
  assert.ok(fallback)
  const tiles = tileCountInBbox(seamark, BBOX, [6, 6])
  assert.equal(estimateBytes(['seamark'], BBOX, [6, 6], {}), tiles * fallback)
})

test('estimateBytes reads only own properties of the supplied averages', () => {
  // Cache statistics are documented as untrusted input, so an inherited or polluted entry must not
  // stand in for a measurement the caller never made.
  const inherited = Object.create({ seamark: 7 }) as Record<string, number>
  assert.equal(estimateBytes(['seamark'], BBOX, [6, 6], inherited), estimateBytes(['seamark'], BBOX, [6, 6], {}))
})

test('estimateBytes uses coverage regions, not the display envelope, for a source that has both', () => {
  const enc = src('depth-noaa-enc')
  // The English Channel sits inside the global NOAA ENC bounds but outside every coverage region.
  assert.equal(estimateBytes(['depth-noaa-enc'], [-5, 48, 5, 52], [0, 10], {}), 0)
  const chesapeake: LngLatBbox = [-77, 36, -75, 38]
  const tiles = tileCountInBbox(enc, chesapeake, [8, 8])
  assert.ok(tiles > 0)
  assert.equal(estimateBytes(['depth-noaa-enc'], chesapeake, [8, 8], {}), tiles * (enc.fallbackTileBytes ?? 0))
})

test('estimateBytes counts a duplicated source id once', () => {
  const once = estimateBytes(['seamark'], BBOX, [6, 6], {})
  assert.equal(estimateBytes(['seamark', 'seamark'], BBOX, [6, 6], {}), once)
})

test('estimateBytes fails closed for unknown source ids', () => {
  assert.throws(() => estimateBytes(['does-not-exist'], BBOX, [6, 6], {}), /unknown chart source/)
})

test('estimateBytes treats a global source (no bounds) as covering any non-empty bbox', () => {
  assert.ok(estimateBytes(['depth-gebco'], SAN_FRANCISCO, [6, 12], {}) > 0)
})

test('estimateBytes returns 0 for a bounded source when the bbox falls outside its bounds', () => {
  // depth-emodnet covers Europe; San Francisco Bay lies outside its bounds.
  assert.equal(estimateBytes(['depth-emodnet'], SAN_FRANCISCO, [6, 8], {}), 0)
})

test('estimateBytes rejects invalid measured averages', () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => estimateBytes(['seamark'], BBOX, [6, 6], { seamark: invalid }), RangeError)
  }
})

test('estimateBytes rejects totals beyond Number.MAX_SAFE_INTEGER', () => {
  const world: LngLatBbox = [-180, -85, 180, 85]
  assert.throws(() => estimateBytes(['seamark'], world, [0, 18], { seamark: 1_000_000 }), /safe integer/)
})
