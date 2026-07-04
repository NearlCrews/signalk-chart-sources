import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TILE_BYTES, estimateBytes } from '../src/estimate.js'
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
  assert.equal(withDefault % DEFAULT_TILE_BYTES, 0)
})

test('estimateBytes skips unknown source ids', () => {
  const bbox: Bbox = [-1, -1, 1, 1]
  assert.equal(estimateBytes(['does-not-exist'], bbox, [6, 6], {}), 0)
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
