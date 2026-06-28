import test from 'node:test'
import assert from 'node:assert/strict'
import { expandUpstreamUrl, proxyTileTemplate } from '../src/expand.js'
import type { ChartSource } from '../src/types.js'

const xyz: ChartSource = { id: 'x', title: 'X', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '', upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}.png' } }
const wmts: ChartSource = { id: 'w', title: 'W', tileSize: 512, minzoom: 0, maxzoom: 16, attribution: '', upstream: { mode: 'wmts', urlTemplate: 'https://h/wmts?TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}' } }
const wms: ChartSource = { id: 's', title: 'S', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '', upstream: { mode: 'wms', base: 'https://w/wms', layers: '0,1', styles: 'q', version: '1.3.0', format: 'image/png', transparent: true } }
const arcgis: ChartSource = { id: 'a', title: 'A', tileSize: 256, minzoom: 0, maxzoom: 18, attribution: '', upstream: { mode: 'arcgis', base: 'https://m/MapServer' } }

test('xyz substitutes z, x, and y', () => {
  assert.equal(expandUpstreamUrl(xyz, 3, 2, 1), 'https://h/3/2/1.png')
})

test('wmts substitutes z, y, and x into its template tokens', () => {
  assert.equal(expandUpstreamUrl(wmts, 5, 9, 7), 'https://h/wmts?TILEMATRIX=EPSG:3857:5&TILEROW=7&TILECOL=9')
})

test('wms injects the 3857 bbox, CRS, size, layers, and styles', () => {
  const url = new URL(expandUpstreamUrl(wms, 0, 0, 0))
  assert.equal(url.searchParams.get('REQUEST'), 'GetMap')
  assert.equal(url.searchParams.get('CRS'), 'EPSG:3857')
  assert.equal(url.searchParams.get('WIDTH'), '256')
  assert.equal(url.searchParams.get('LAYERS'), '0,1')
  assert.equal(url.searchParams.get('STYLES'), 'q')
  const bbox = (url.searchParams.get('BBOX') ?? '').split(',').map(Number)
  assert.equal(bbox.length, 4)
  assert.ok(Math.abs(bbox[0] - -20037508.342789244) < 1e-3)
})

test('arcgis builds the export query with the tile bbox', () => {
  const url = new URL(expandUpstreamUrl(arcgis, 1, 0, 0))
  assert.ok(url.pathname.endsWith('/MapServer/export'))
  assert.equal(url.searchParams.get('bboxSR'), '3857')
  assert.equal(url.searchParams.get('size'), '256,256')
})

test('an out-of-range tile coordinate throws', () => {
  assert.throws(() => expandUpstreamUrl(xyz, 1, 2, 0), RangeError) // x 2 >= 2^1
  assert.throws(() => expandUpstreamUrl(wms, 30, 0, 0), RangeError) // z above maxzoom
})

test('proxyTileTemplate builds the plugin-facing tile template', () => {
  assert.equal(proxyTileTemplate('/plugins/signalk-binnacle-companion', 'depth-gebco'), '/plugins/signalk-binnacle-companion/tile/depth-gebco/{z}/{x}/{y}')
})
