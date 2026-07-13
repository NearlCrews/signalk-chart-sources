import test from 'node:test'
import assert from 'node:assert/strict'
import { validateChartSource } from '../src/validate.js'
import { makeSource } from './fixtures.js'

test('validateChartSource accepts a complete source', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource()))
})

test('validateChartSource rejects invalid ids, zooms, coverage, estimates, and templates', () => {
  assert.throws(() => validateChartSource(makeSource({ id: '../x' })), /invalid source id/)
  assert.throws(() => validateChartSource(makeSource({ minzoom: 4, maxzoom: 3 })), /minzoom exceeds/)
  assert.throws(() => validateChartSource(makeSource({ coverage: [] })), /must not be empty/)
  assert.throws(() => validateChartSource(makeSource({ fallbackTileBytes: -1 })), /positive safe integer/)
  assert.throws(() => validateChartSource(makeSource({
    upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}.png' }
  })), /missing \{y\}/)
})

test('validateChartSource checks style host authorization', () => {
  assert.throws(() => validateChartSource(makeSource({
    upstream: { mode: 'style', styleUrl: 'https://tiles.example/style.json', allowedHosts: ['other.example'] }
  })), /must include tiles.example/)
})
