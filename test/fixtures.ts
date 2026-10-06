import assert from 'node:assert/strict'
import { chartSourceById } from '../src/registry.js'
import type { ChartSource } from '../src/types.js'

/** A minimal valid ChartSource for tests: a worldwide xyz source unless overridden. */
export const makeSource = (over: Partial<ChartSource> = {}): ChartSource => ({
  id: 's',
  title: 'S',
  tileSize: 256,
  minzoom: 0,
  maxzoom: 18,
  attribution: '',
  upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' },
  ...over
})

/** Look up a catalog source; a typo'd id fails the test loudly instead of returning undefined. */
export const src = (id: string): ChartSource => {
  const source = chartSourceById(id)
  assert.ok(source, `${id} must be in the catalog`)
  return source
}

/** A deterministic generator of values in [0, 1), so a property test replays the same samples. */
export const seededRandom = (seed: number): (() => number) => {
  let state = seed
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 2 ** 32
  }
}
