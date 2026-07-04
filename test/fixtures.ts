import type { ChartSource } from '../src/types.js'

/** A minimal valid ChartSource for tests: a worldwide xyz source unless overridden. */
export const makeSource = (over: Partial<ChartSource> = {}): ChartSource => ({
  id: 's', title: 'S', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '',
  upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' },
  ...over
})
