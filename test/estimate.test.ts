import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TILE_BYTES, estimateBytes } from '../src/estimate.js'

test('estimateBytes sums tileCount times the per-source average', () => {
  const bbox: [number, number, number, number] = [-1, -1, 1, 1]
  const withAvg = estimateBytes(['seamark'], bbox, [6, 6], { seamark: 100 })
  assert.ok(withAvg > 0)
  assert.equal(withAvg % 100, 0)
})

test('estimateBytes falls back to DEFAULT_TILE_BYTES for an uncached source', () => {
  const bbox: [number, number, number, number] = [-1, -1, 1, 1]
  const withDefault = estimateBytes(['seamark'], bbox, [6, 6], {})
  assert.ok(withDefault > 0)
  assert.equal(withDefault % DEFAULT_TILE_BYTES, 0)
})

test('estimateBytes skips unknown source ids', () => {
  const bbox: [number, number, number, number] = [-1, -1, 1, 1]
  assert.equal(estimateBytes(['does-not-exist'], bbox, [6, 6], {}), 0)
})

test('estimateBytes treats a global source (no bounds) as covering any non-empty bbox', () => {
  const bbox: [number, number, number, number] = [-122.5, 37.5, -122.0, 38.0]
  assert.ok(estimateBytes(['depth-gebco'], bbox, [6, 12], {}) > 0)
})
