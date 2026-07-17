import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateBytes } from '../src/estimate.js'
import { chartSourceById } from '../src/registry.js'
import type { Bbox } from '../src/types.js'

test('estimateBytes sums tileCount times the per-source average', () => {
  const bbox: Bbox = [-1, -1, 1, 1]
  const withAvg = estimateBytes(['seamark'], bbox, [6, 6], { seamark: 100 })
  assert.ok(withAvg > 0)
  assert.equal(withAvg % 100, 0)
})

test('estimateBytes falls back to DEFAULT_TILE_BYTES for an uncached source', () => {
  const bbox: Bbox = [-1, -1, 1, 1]
  const withDefault = estimateBytes(['seamark'], bbox, [6, 6], {})
  assert.ok(withDefault > 0)
  const fallback = chartSourceById('seamark')?.fallbackTileBytes
  assert.ok(fallback)
  assert.equal(withDefault % fallback, 0)
})

test('estimateBytes fails closed for unknown source ids', () => {
  const bbox: Bbox = [-1, -1, 1, 1]
  assert.throws(() => estimateBytes(['does-not-exist'], bbox, [6, 6], {}), /unknown chart source/)
})

test('estimateBytes treats a global source (no bounds) as covering any non-empty bbox', () => {
  const bbox: Bbox = [-122.5, 37.5, -122.0, 38.0]
  assert.ok(estimateBytes(['depth-gebco'], bbox, [6, 12], {}) > 0)
})

test('estimateBytes returns 0 for a bounded source when the bbox falls outside its bounds', () => {
  // depth-emodnet covers Europe; San Francisco Bay lies outside its bounds.
  const bbox: Bbox = [-122.5, 37.5, -122.0, 38.0]
  assert.equal(estimateBytes(['depth-emodnet'], bbox, [6, 8], {}), 0)
})

test('estimateBytes rejects invalid measured averages', () => {
  const bbox: Bbox = [-1, -1, 1, 1]
  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(() => estimateBytes(['seamark'], bbox, [6, 6], { seamark: invalid }), RangeError)
  }
})

test('estimateBytes rejects totals beyond Number.MAX_SAFE_INTEGER', () => {
  const world: Bbox = [-180, -85, 180, 85]
  assert.throws(() => estimateBytes(['seamark'], world, [0, 18], { seamark: 1_000_000 }), /safe integer/)
})
