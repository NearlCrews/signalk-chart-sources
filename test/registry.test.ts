import test from 'node:test'
import assert from 'node:assert/strict'
import { CHART_SOURCES } from '../src/registry.js'
import { expandUpstreamUrl } from '../src/expand.js'

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
  assert.equal(basemap.id, 'basemap')
  assert.equal(basemap.upstream.mode, 'style')
  if (basemap.upstream.mode === 'style') {
    assert.deepEqual(basemap.upstream.allowedHosts, ['tiles.openfreemap.org'])
  }
})

test('key sources pin their transcribed upstream data (drift guard)', () => {
  const gebco = CHART_SOURCES.find((s) => s.id === 'depth-gebco')
  assert.ok(gebco && gebco.upstream.mode === 'wms')
  if (gebco && gebco.upstream.mode === 'wms') {
    assert.equal(gebco.upstream.base, 'https://wms.gebco.net/mapserv')
    assert.equal(gebco.upstream.layers, 'GEBCO_LATEST')
  }
  const enc = CHART_SOURCES.find((s) => s.id === 'depth-noaa-enc')
  assert.ok(enc && enc.upstream.mode === 'wms')
  if (enc && enc.upstream.mode === 'wms') assert.equal(enc.upstream.layers, '0,1,2,3,4,5,6,7,10')
  const bluetopo = CHART_SOURCES.find((s) => s.id === 'depth-bluetopo')
  assert.equal(bluetopo?.tileSize, 512)
  assert.equal(bluetopo?.upstream.mode, 'wmts')
})

test('chart bounds separate US and EU coverage so defaults and the summary stay honest', () => {
  const byId = Object.fromEntries(CHART_SOURCES.map((s) => [s.id, s]))
  const inBox = (b, lng, lat) =>
    b !== undefined && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]
  // NOAA ENC is US only: a Mediterranean point (Naples) is outside it; a US point (Newport) is inside.
  assert.equal(inBox(byId['depth-noaa-enc'].bounds, 14.25, 40.8), false)
  assert.equal(inBox(byId['depth-noaa-enc'].bounds, -71.3, 41.5), true)
  // EMODnet is EU only: a US northeast point (Boston) is outside it; an EU point (English Channel) is inside.
  assert.equal(inBox(byId['depth-emodnet'].bounds, -71, 42.3), false)
  assert.equal(inBox(byId['depth-emodnet'].bounds, 0, 50), true)
  // The EU protected-area layers now carry bounds so they self-hide outside Europe.
  assert.ok(byId['mpa-emodnet'].bounds)
  assert.ok(byId['mpa-natura2000'].bounds)
  assert.equal(inBox(byId['mpa-emodnet'].bounds, -71, 42.3), false)
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
  }
})

test('BlueTopo bounds pin the US extent from the service capabilities (drift guard)', () => {
  const bluetopo = CHART_SOURCES.find((s) => s.id === 'depth-bluetopo')
  assert.ok(bluetopo?.bounds, 'depth-bluetopo must carry bounds')
  // South is a positive latitude and east is a negative longitude; a regression to the earlier
  // South Atlantic and European box fails here.
  assert.deepEqual(bluetopo?.bounds, [-138.0, 16.786, -64.198, 59.55])
})
