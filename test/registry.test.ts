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
    if (s.kind === 'style') continue
    const url = expandUpstreamUrl(s, s.minzoom, 0, 0)
    assert.ok(/^https:\/\//.test(url), `${s.id} expanded to ${url}`)
  }
})

test('the basemap is the single style source and carries an allowed host', () => {
  const styles = CHART_SOURCES.filter((s) => s.kind === 'style')
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
  assert.equal(bluetopo?.kind, 'wmts')
})
