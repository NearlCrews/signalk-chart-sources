import test from 'node:test'
import assert from 'node:assert/strict'
import { CHART_SOURCES, chartSourceById } from '../src/registry.js'
import { expandUpstreamUrl } from '../src/expand.js'
import type { Bbox, ChartSource } from '../src/types.js'

// A typo'd id must fail the test, not silently return undefined, so lookups assert.
const src = (id: string): ChartSource => {
  const s = chartSourceById(id)
  assert.ok(s, `${id} must be in the catalog`)
  return s
}

test('every source id is unique', () => {
  const ids = CHART_SOURCES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('every non-style source expands to an absolute https URL at its minzoom', () => {
  for (const s of CHART_SOURCES) {
    if (s.upstream.mode === 'style') continue
    const url = expandUpstreamUrl(s, s.minzoom, 0, 0)
    assert.ok(/^https:\/\//.test(url), `${s.id} expanded to ${url}`)
  }
})

test('the basemap is the single style source and carries an allowed host', () => {
  const styles = CHART_SOURCES.filter((s) => s.upstream.mode === 'style')
  assert.equal(styles.length, 1)
  const basemap = styles[0]
  assert.ok(basemap, 'the style source must exist')
  assert.equal(basemap.id, 'basemap')
  assert.ok(basemap.upstream.mode === 'style')
  assert.deepEqual(basemap.upstream.allowedHosts, ['tiles.openfreemap.org'])
})

test('key sources pin their transcribed upstream data (drift guard)', () => {
  const gebco = src('depth-gebco')
  assert.ok(gebco.upstream.mode === 'wms')
  assert.equal(gebco.upstream.base, 'https://wms.gebco.net/mapserv')
  assert.equal(gebco.upstream.layers, 'GEBCO_LATEST')
  const enc = src('depth-noaa-enc')
  assert.ok(enc.upstream.mode === 'wms')
  assert.equal(enc.upstream.layers, '0,1,2,3,4,5,6,7,10')
  const bluetopo = src('depth-bluetopo')
  assert.equal(bluetopo.tileSize, 512)
  assert.equal(bluetopo.upstream.mode, 'wmts')
  const seamark = src('seamark')
  assert.ok(seamark.upstream.mode === 'xyz')
  assert.equal(seamark.upstream.urlTemplate, 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png')
  const mpaNoaa = src('mpa-noaa')
  assert.ok(mpaNoaa.upstream.mode === 'arcgis')
  assert.equal(
    mpaNoaa.upstream.base,
    'https://gis.charttools.noaa.gov/arcgis/rest/services/survey_priorities2_national/MPA_Inventory_Separates/MapServer'
  )
  const basemap = src('basemap')
  assert.ok(basemap.upstream.mode === 'style')
  assert.equal(basemap.upstream.styleUrl, 'https://tiles.openfreemap.org/styles/liberty')
  const seascapeDem = src('seascape-dem')
  assert.ok(seascapeDem.upstream.mode === 'xyz')
  assert.equal(seascapeDem.upstream.urlTemplate, 'https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp')
  assert.equal(seascapeDem.tileSize, 512)
  const seascapeVector = src('seascape-vector')
  assert.ok(seascapeVector.upstream.mode === 'xyz')
  assert.equal(seascapeVector.upstream.urlTemplate, 'https://tiles.openwaters.io/seascape/{z}/{x}/{y}.pbf')
})

test('chartSourceById returns the catalog entry or undefined', () => {
  assert.equal(chartSourceById('depth-gebco')?.title, 'GEBCO bathymetry')
  assert.equal(chartSourceById('does-not-exist'), undefined)
})

test('chart bounds preserve service coverage envelopes', () => {
  const inBox = (b: Bbox | undefined, lng: number, lat: number): boolean =>
    b !== undefined && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]
  // NOAA ENC reports a global service envelope because it includes remote US chart coverage.
  assert.equal(inBox(src('depth-noaa-enc').bounds, 144.8, 13.5), true)
  assert.equal(inBox(src('depth-noaa-enc').bounds, -71.3, 41.5), true)
  // EMODnet is EU only: a US northeast point (Boston) is outside it; an EU point (English Channel) is inside.
  assert.equal(inBox(src('depth-emodnet').bounds, -71, 42.3), false)
  assert.equal(inBox(src('depth-emodnet').bounds, 0, 50), true)
  // The EU protected-area layers now carry bounds so they self-hide outside Europe.
  assert.ok(src('mpa-emodnet').bounds)
  assert.ok(src('mpa-natura2000').bounds)
  assert.equal(inBox(src('mpa-emodnet').bounds, -71, 42.3), false)
})

test('the catalog and every nested source object are immutable', () => {
  assert.ok(Object.isFrozen(CHART_SOURCES))
  const source = src('depth-gebco')
  assert.ok(Object.isFrozen(source))
  assert.ok(Object.isFrozen(source.upstream))
  assert.throws(() => (CHART_SOURCES as unknown as ChartSource[]).pop(), TypeError)
  assert.equal(chartSourceById('depth-gebco'), source)
})

test('every source has a sane zoom range and a vectorMaxzoom within maxzoom', () => {
  for (const s of CHART_SOURCES) {
    assert.ok(s.minzoom <= s.maxzoom, `${s.id} minzoom ${s.minzoom} > maxzoom ${s.maxzoom}`)
    if (s.vectorMaxzoom !== undefined) {
      assert.ok(s.vectorMaxzoom <= s.maxzoom, `${s.id} vectorMaxzoom ${s.vectorMaxzoom} > maxzoom ${s.maxzoom}`)
    }
  }
})

test('every bounded source has a finite, non-degenerate west, south, east, north box', () => {
  for (const s of CHART_SOURCES) {
    if (!s.bounds) continue
    const [west, south, east, north] = s.bounds
    assert.ok([west, south, east, north].every(Number.isFinite), `${s.id} bounds must be finite`)
    assert.ok(west < east, `${s.id} west ${west} must be less than east ${east}`)
    assert.ok(south < north, `${s.id} south ${south} must be less than north ${north}`)
    assert.ok(west >= -180 && east <= 180, `${s.id} longitudes must fall within [-180, 180]`)
    assert.ok(south >= -90 && north <= 90, `${s.id} latitudes must fall within [-90, 90]`)
  }
})

test('sources sharing a group id share one group title and one attribution', () => {
  const members = new Map<string, ChartSource[]>()
  for (const s of CHART_SOURCES) {
    if (!s.group) continue
    const list = members.get(s.group.id) ?? []
    list.push(s)
    members.set(s.group.id, list)
  }
  for (const [id, group] of members) {
    assert.equal(new Set(group.map((m) => m.group?.title)).size, 1, `group ${id} must carry one title`)
    assert.equal(new Set(group.map((m) => m.attribution)).size, 1, `group ${id} must share one attribution`)
  }
})

test('BlueTopo bounds pin the US extent from the service capabilities (drift guard)', () => {
  const bluetopo = src('depth-bluetopo')
  assert.ok(bluetopo.bounds, 'depth-bluetopo must carry bounds')
  // South is a positive latitude and east is a negative longitude; a regression to the earlier
  // South Atlantic and European box fails here.
  assert.deepEqual(bluetopo.bounds, [-138.0, 16.786, -64.198, 59.55])
})
