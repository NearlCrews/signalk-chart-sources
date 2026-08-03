import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_TILE_BYTES_BY_MODE, estimateBytes } from '../src/estimate.js'
import { tileCountInBbox } from '../src/mercator.js'
import type { LngLatBbox } from '../src/types.js'
import { makeSource, src } from './fixtures.js'

const BBOX: LngLatBbox = [-1, -1, 1, 1]
const SAN_FRANCISCO: LngLatBbox = [-122.5, 37.5, -122.0, 38.0]

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
  assert.throws(() => estimateBytes(['does-not-exist'], BBOX, [6, 6], {}), {
    name: 'RangeError',
    message: /unknown chart source/
  })
})

test('estimateBytes accepts a whole source, so a consumer can price one it defined itself', () => {
  const custom = makeSource({ id: 'custom', fallbackTileBytes: 1_000 })
  const tiles = tileCountInBbox(custom, BBOX, [6, 6])
  assert.ok(tiles > 0)
  assert.equal(estimateBytes([custom], BBOX, [6, 6], {}), tiles * 1_000)
  // A measured average is keyed by the source's own id, the same as for a catalog entry.
  assert.equal(estimateBytes([custom], BBOX, [6, 6], { custom: 7 }), tiles * 7)
  // Ids and whole sources mix, and are still counted once each.
  const both = estimateBytes([custom, 'seamark'], BBOX, [6, 6], {})
  assert.equal(both, estimateBytes([custom], BBOX, [6, 6], {}) + estimateBytes(['seamark'], BBOX, [6, 6], {}))
  assert.equal(estimateBytes([custom, custom, 'seamark', 'seamark'], BBOX, [6, 6], {}), both)
  // The first occurrence wins: a whole source under a catalog id shadows the id listed after it.
  const shadowing = makeSource({ id: 'seamark', fallbackTileBytes: 1 })
  const shadowedTiles = tileCountInBbox(shadowing, BBOX, [6, 6])
  assert.equal(estimateBytes([shadowing, 'seamark'], BBOX, [6, 6], {}), shadowedTiles * 1)
})

test('estimateBytes checks a supplied source before trusting it', () => {
  // The id is checked first, because an unchecked one could name itself into the averages lookup,
  // or into the dedupe set to suppress a real source that shares the id.
  const invalid = makeSource({ id: 'Not A Valid Id' })
  assert.throws(() => estimateBytes([invalid], BBOX, [6, 6], {}), { name: 'TypeError', message: /invalid source id/ })
  // The rest of the shape is still checked, by tileCountInBbox, before any tile is counted.
  assert.throws(() => estimateBytes([makeSource({ maxzoom: -1 })], BBOX, [6, 6], {}), {
    name: 'RangeError',
    message: /maxzoom must be an integer/
  })
})

test('estimateBytes treats a global source (no bounds) as covering any non-empty bbox', () => {
  assert.ok(estimateBytes(['depth-gebco'], SAN_FRANCISCO, [6, 12], {}) > 0)
})

test('estimateBytes returns 0 for a bounded source when the bbox falls outside its bounds', () => {
  // mpa-emodnet carries bounds and no coverage, so this isolates the bounds arm of the clip;
  // San Francisco Bay lies outside its European envelope.
  const bounded = src('mpa-emodnet')
  assert.equal(bounded.coverage, undefined, 'mpa-emodnet must stay a bounds-only source for this test')
  assert.equal(estimateBytes(['mpa-emodnet'], SAN_FRANCISCO, [6, 8], {}), 0)
})

test('estimateBytes rejects invalid measured averages', () => {
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => estimateBytes(['seamark'], BBOX, [6, 6], { seamark: invalid }), RangeError)
  }
})

test('estimateBytes rejects totals beyond Number.MAX_SAFE_INTEGER', () => {
  const world: LngLatBbox = [-180, -85, 180, 85]
  assert.throws(() => estimateBytes(['seamark'], world, [0, 18], { seamark: 1_000_000 }), {
    name: 'RangeError',
    message: /safe integer/
  })
})
