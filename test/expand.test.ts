import assert from 'node:assert/strict'
import test from 'node:test'
import { expandUpstreamUrl, proxyTileTemplate, upstreamTileTemplate } from '../src/expand.js'
import { webMercatorTileBounds } from '../src/mercator.js'
import { CHART_SOURCES } from '../src/registry.js'
import type { ChartSource } from '../src/types.js'
import { makeSource, src } from './fixtures.js'

const xyz = makeSource({ id: 'x', title: 'X' })
const wmts = makeSource({
  id: 'w',
  title: 'W',
  tileSize: 512,
  maxzoom: 16,
  upstream: { mode: 'wmts', urlTemplate: 'https://h/wmts?TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}' }
})
const wms = makeSource({
  id: 's',
  title: 'S',
  upstream: {
    mode: 'wms',
    base: 'https://w/wms',
    layers: '0,1',
    styles: 'q,r',
    version: '1.3.0',
    format: 'image/png',
    transparent: true
  }
})
const arcgis = makeSource({ id: 'a', title: 'A', upstream: { mode: 'arcgis', base: 'https://m/MapServer' } })

/**
 * A 512 pixel, opaque, non-png WMS source and a 512 pixel ArcGIS source, so size, transparency, and
 * format all have to come from the source rather than from a hardcoded default. Their bases carry a
 * trailing slash, which every request built from them must drop.
 */
const wms512 = makeSource({
  id: 'w5',
  tileSize: 512,
  upstream: {
    mode: 'wms',
    base: 'https://w.example/wms/',
    layers: 'a,b',
    styles: 'x,y',
    version: '1.3.0',
    format: 'image/jpeg',
    transparent: false
  }
})
const arcgis512 = makeSource({
  id: 'a5',
  tileSize: 512,
  upstream: { mode: 'arcgis', base: 'https://m.example/MapServer/' }
})

const style = makeSource({
  id: 'b',
  title: 'B',
  maxzoom: 20,
  vectorMaxzoom: 14,
  upstream: { mode: 'style', styleUrl: 'https://tiles.example/styles/liberty', allowedHosts: ['tiles.example'] }
})

/** The BBOX parameter, spelled uppercase by WMS and lowercase by ArcGIS. */
const bboxOf = (url: string): string => /[?&]bbox=([^&]*)/i.exec(url)?.[1] ?? ''
const bboxNumbers = (url: string): number[] => bboxOf(url).split(',').map(Number)

test('xyz substitutes z, x, and y', () => {
  assert.equal(expandUpstreamUrl(xyz, 3, 2, 1), 'https://h/3/2/1.png')
})

test('wmts substitutes z, y, and x into its template tokens', () => {
  assert.equal(expandUpstreamUrl(wmts, 5, 9, 7), 'https://h/wmts?TILEMATRIX=EPSG:3857:5&TILEROW=7&TILECOL=9')
})

test('the bbox is emitted as minX,minY,maxX,maxY for a tile where x and y differ', () => {
  // Every other bbox assertion uses tile 0/0 or a symmetric tile, where swapping the x and y axes,
  // or the min and max pairs, produces an identical string.
  const url = expandUpstreamUrl(wms, 4, 3, 11)
  const bbox = bboxNumbers(url)
  const [, minY] = bbox
  // Pinned exactly: minX, minY, maxX, maxY, all negative because tile 3/11 at z4 lies west of the
  // meridian and south of the equator. Any axis swap or min/max swap changes this literal.
  assert.deepEqual(bbox, [-12523442.714243278, -10018754.171394622, -10018754.171394622, -7514065.628545966])
  // The tile below must begin where this one ends, which a y-axis inversion would break. Compared
  // with a tolerance because the shared edge is reached by two different expressions, so the two
  // tiles can disagree in the final ULP.
  const below = bboxNumbers(expandUpstreamUrl(wms, 4, 3, 12))
  assert.ok(Math.abs((below[3] ?? 0) - (minY ?? 0)) < 1e-6, 'the next tile down must start where this one ends')
  assert.ok((below[1] ?? 0) < (minY ?? 0), 'the next tile down must extend further south')
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
  assert.equal(url.searchParams.get('STYLES'), 'q,r')
  const bbox = bboxNumbers(url.href)
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

test('arcgis normalizes trailing slashes before appending export', () => {
  const trailing = makeSource({
    id: 'a',
    upstream: { mode: 'arcgis', base: `https://m/MapServer${'/'.repeat(1_024)}` }
  })
  const url = new URL(expandUpstreamUrl(trailing, 1, 0, 0))
  assert.equal(url.pathname, '/MapServer/export')
})

test('wms normalizes trailing slashes the same way arcgis does', () => {
  // One base must not yield two spellings of the same GetMap, which would split a proxy's cache.
  assert.ok(wms.upstream.mode === 'wms')
  const trailing = makeSource({
    id: 's',
    upstream: { ...wms.upstream, base: `https://w/wms${'/'.repeat(1_024)}` }
  })
  assert.equal(new URL(expandUpstreamUrl(trailing, 1, 0, 0)).pathname, '/wms')
  assert.equal(expandUpstreamUrl(trailing, 1, 0, 0), expandUpstreamUrl(wms, 1, 0, 0))
})

test('the full WMS and ArcGIS request strings are pinned byte for byte', () => {
  // Proxy caches key on the exact text, and Binnacle's wmsTiles and the Rust expand_upstream build the
  // same strings, so parameter order, case, size, and transparency all have to hold. Pinned at a
  // 512 pixel, opaque source and an asymmetric tile, where an x and y swap would change the box.
  assert.equal(
    expandUpstreamUrl(wms512, 4, 3, 11),
    'https://w.example/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=a,b&CRS=EPSG:3857' +
      '&BBOX=-12523442.714243278,-10018754.171394622,-10018754.171394622,-7514065.628545966' +
      '&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg&TRANSPARENT=false&STYLES=x,y'
  )
  assert.equal(
    expandUpstreamUrl(arcgis512, 4, 3, 11),
    'https://m.example/MapServer/export' +
      '?bbox=-12523442.714243278,-10018754.171394622,-10018754.171394622,-7514065.628545966' +
      '&bboxSR=3857&imageSR=3857&size=512,512&dpi=96&format=png32&transparent=true&f=image'
  )
})

test('a zoom below the source minzoom throws', () => {
  const shallow = makeSource({ minzoom: 3 })
  assert.equal(expandUpstreamUrl(shallow, 3, 0, 0), 'https://h/3/0/0.png')
  assert.throws(() => expandUpstreamUrl(shallow, 2, 0, 0), { name: 'RangeError', message: /out of s range/ })
})

test('an out-of-range tile coordinate throws', () => {
  assert.throws(() => expandUpstreamUrl(xyz, 1, 2, 0), RangeError) // x 2 >= 2^1
  assert.throws(() => expandUpstreamUrl(wms, 30, 0, 0), RangeError) // z above maxzoom
  assert.throws(() => expandUpstreamUrl(xyz, 1, -1, 0), RangeError) // negative x
  assert.throws(() => expandUpstreamUrl(xyz, 1, 0, 2), RangeError) // y 2 >= 2^1
  assert.throws(() => expandUpstreamUrl(xyz, 1, 0.5, 0), RangeError) // non-integer coordinate
})

test('the bbox parameter never uses exponential notation', () => {
  // A tile edge on the projection origin arrives as floating-point residue, and Number#toString
  // renders a small enough magnitude as "9.31e-10", which the OGC BBOX grammar does not admit.
  const exponential = /e[+-]?\d/i
  // z3/3/3 touches both the prime meridian and the equator, so three of its four edges are residue.
  assert.equal(bboxOf(expandUpstreamUrl(wms, 3, 3, 3)), '-5009377.085697312,0,0,5009377.085697312')

  for (let z = 0; z <= 10; z++) {
    const n = 2 ** z
    // The tiles adjacent to the meridian and the equator are where the residue appears.
    const edges = [...new Set([0, n / 2 - 1, n / 2, n - 1])].filter((v) => Number.isInteger(v) && v >= 0 && v < n)
    for (const x of edges) {
      for (const y of edges) {
        const bbox = bboxOf(expandUpstreamUrl(wms, z, x, y))
        assert.ok(!exponential.test(bbox), `z${z}/${x}/${y} produced ${bbox}`)
        assert.equal(bbox.split(',').length, 4)
      }
    }
  }
  assert.ok(!exponential.test(bboxOf(expandUpstreamUrl(arcgis, 3, 3, 3))))
})

test('a source built on accessors cannot swap its upstream between validation and expansion', () => {
  let reads = 0
  const swapping = {
    ...makeSource(),
    get upstream() {
      reads++
      return reads === 1
        ? { mode: 'xyz', urlTemplate: 'https://good.example/{z}/{x}/{y}.png' }
        : { mode: 'xyz', urlTemplate: 'http://evil.example/{z}/{x}/{y}.png' }
    }
  } as unknown as ChartSource
  assert.equal(expandUpstreamUrl(swapping, 1, 0, 0), 'https://good.example/1/0/0.png')
  assert.equal(reads, 1)
})

test('a non-object source or upstream is rejected by the validator, not a property read', () => {
  assert.throws(() => expandUpstreamUrl(null as unknown as ChartSource, 0, 0, 0), {
    name: 'TypeError',
    message: /chart source must be an object/
  })
  assert.throws(() => expandUpstreamUrl({ ...xyz, upstream: null } as unknown as ChartSource, 0, 0, 0), {
    name: 'TypeError',
    message: /upstream must be an object/
  })
})

test('only the catalog object itself skips revalidation, not a copy that looks like it', () => {
  // Trust is by identity: a spread of a catalog source is a new object and is validated in full.
  const seamark = src('seamark')
  assert.ok(seamark.upstream.mode === 'xyz')
  assert.equal(expandUpstreamUrl(seamark, 3, 1, 2), 'https://tiles.openseamap.org/seamark/3/1/2.png')
  const tampered = { ...seamark, upstream: { mode: 'xyz', urlTemplate: 'http://evil.example/{z}/{x}/{y}.png' } }
  assert.throws(() => expandUpstreamUrl(tampered as ChartSource, 3, 1, 2), /must use https/)
})

test('proxyTileTemplate builds the plugin-facing tile template', () => {
  assert.equal(
    proxyTileTemplate('/plugins/signalk-chart-locker', 'depth-gebco'),
    '/plugins/signalk-chart-locker/tile/depth-gebco/{z}/{x}/{y}'
  )
  assert.equal(
    proxyTileTemplate(`/plugins/signalk-chart-locker${'/'.repeat(10_000)}`, 'depth-gebco'),
    '/plugins/signalk-chart-locker/tile/depth-gebco/{z}/{x}/{y}'
  )
  assert.throws(() => proxyTileTemplate('', 'depth-gebco'), TypeError)
  assert.throws(() => proxyTileTemplate('/plugins/signalk-chart-locker', '../secret'), TypeError)
  assert.throws(() => proxyTileTemplate('/plugins/chart locker', 'depth-gebco'), {
    name: 'TypeError',
    message: /whitespace/
  })
  assert.throws(() => proxyTileTemplate('/plugins/x?a=1', 'depth-gebco'), TypeError)
  assert.throws(() => proxyTileTemplate('/plugins/{z}', 'depth-gebco'), TypeError)
  // URL parsers read a backslash as a path separator, so the template text would not describe the
  // path a client actually requests.
  assert.throws(() => proxyTileTemplate('/plugins/a\\b', 'depth-gebco'), { name: 'TypeError', message: /backslashes/ })
  assert.throws(() => proxyTileTemplate(undefined as unknown as string, 'depth-gebco'), {
    name: 'TypeError',
    message: /must be a string/
  })
})

/** Fill a tile template the way MapLibre does: z, x, and y tokens, and the bbox token with the box. */
const fillTemplate = (template: string, z: number, x: number, y: number): string =>
  template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{bbox-epsg-3857}', webMercatorTileBounds(z, x, y).join(','))

test('upstreamTileTemplate puts the bbox token where expandUpstreamUrl writes the tile box', () => {
  assert.equal(
    upstreamTileTemplate(wms512),
    'https://w.example/wms?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=a,b&CRS=EPSG:3857' +
      '&BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512&FORMAT=image/jpeg&TRANSPARENT=false&STYLES=x,y'
  )
  assert.equal(
    upstreamTileTemplate(arcgis512),
    'https://m.example/MapServer/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857' +
      '&size=512,512&dpi=96&format=png32&transparent=true&f=image'
  )
  // Tiles clear of the projection origin, where the box needs no residue snapping, so filling the
  // token with the plain bounds must reproduce the upstream request exactly.
  for (const [z, x, y] of [
    [4, 3, 11],
    [9, 100, 300],
    [12, 4000, 1000],
    [18, 12345, 67890]
  ] as const) {
    for (const source of [wms512, arcgis512]) {
      assert.equal(fillTemplate(upstreamTileTemplate(source), z, x, y), expandUpstreamUrl(source, z, x, y))
    }
  }
})

test('upstreamTileTemplate returns XYZ and WMTS templates as written, and refuses a style source', () => {
  assert.equal(upstreamTileTemplate(xyz), 'https://h/{z}/{x}/{y}.png')
  assert.equal(fillTemplate(upstreamTileTemplate(wmts), 5, 9, 7), expandUpstreamUrl(wmts, 5, 9, 7))
  assert.throws(() => upstreamTileTemplate(style), { name: 'TypeError', message: /b is a style source/ })
  assert.throws(() => upstreamTileTemplate({ ...xyz, id: 'NOT VALID' }), /invalid source id/)
})

test('every catalog tile template reproduces the upstream request once filled', () => {
  for (const source of CHART_SOURCES) {
    if (source.upstream.mode === 'style') continue
    // z3 tile 1/2 has no edge on the projection origin, so the plain bounds need no snapping.
    const z = Math.max(source.minzoom, 3)
    assert.equal(fillTemplate(upstreamTileTemplate(source), z, 1, 2), expandUpstreamUrl(source, z, 1, 2), source.id)
  }
})
