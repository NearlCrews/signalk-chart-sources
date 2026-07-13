import test from 'node:test'
import assert from 'node:assert/strict'
import { expandUpstreamUrl, proxyTileTemplate } from '../src/expand.js'
import { makeSource } from './fixtures.js'

const xyz = makeSource({ id: 'x', title: 'X' })
const wmts = makeSource({ id: 'w', title: 'W', tileSize: 512, maxzoom: 16, upstream: { mode: 'wmts', urlTemplate: 'https://h/wmts?TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}' } })
const wms = makeSource({ id: 's', title: 'S', upstream: { mode: 'wms', base: 'https://w/wms', layers: '0,1', styles: 'q', version: '1.3.0', format: 'image/png', transparent: true } })
const arcgis = makeSource({ id: 'a', title: 'A', upstream: { mode: 'arcgis', base: 'https://m/MapServer' } })
const style = makeSource({ id: 'b', title: 'B', maxzoom: 20, vectorMaxzoom: 14, upstream: { mode: 'style', styleUrl: 'https://tiles.example/styles/liberty', allowedHosts: ['tiles.example'] } })

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
  assert.equal(url.searchParams.get('HEIGHT'), '256')
  assert.equal(url.searchParams.get('VERSION'), '1.3.0')
  assert.equal(url.searchParams.get('FORMAT'), 'image/png')
  assert.equal(url.searchParams.get('TRANSPARENT'), 'true')
  assert.equal(url.searchParams.get('LAYERS'), '0,1')
  assert.equal(url.searchParams.get('STYLES'), 'q')
  const bbox = (url.searchParams.get('BBOX') ?? '').split(',').map(Number)
  assert.equal(bbox.length, 4)
  assert.ok(Math.abs((bbox[0] ?? Number.NaN) - -20037508.342789244) < 1e-3)
})

test('a style source returns its style URL unchanged', () => {
  assert.equal(expandUpstreamUrl(style, 0, 0, 0), 'https://tiles.example/styles/liberty')
  assert.throws(() => expandUpstreamUrl(style, -1, 0, 0), RangeError)
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
  assert.throws(() => expandUpstreamUrl(xyz, 1, -1, 0), RangeError) // negative x
  assert.throws(() => expandUpstreamUrl(xyz, 1, 0, 2), RangeError) // y 2 >= 2^1
  assert.throws(() => expandUpstreamUrl(xyz, 1, 0.5, 0), RangeError) // non-integer coordinate
})

test('proxyTileTemplate builds the plugin-facing tile template', () => {
  assert.equal(proxyTileTemplate('/plugins/signalk-chart-locker', 'depth-gebco'), '/plugins/signalk-chart-locker/tile/depth-gebco/{z}/{x}/{y}')
  assert.equal(proxyTileTemplate('/plugins/signalk-chart-locker/', 'depth-gebco'), '/plugins/signalk-chart-locker/tile/depth-gebco/{z}/{x}/{y}')
  assert.throws(() => proxyTileTemplate('', 'depth-gebco'), TypeError)
  assert.throws(() => proxyTileTemplate('/plugins/signalk-chart-locker', '../secret'), TypeError)
})
