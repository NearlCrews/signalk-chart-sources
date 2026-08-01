import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPECTED_EXPORTS } from '../scripts/expected-exports.mjs'
import { expandUpstreamUrl } from '../src/expand.js'
import { assertGroupCoherence, CHART_SOURCES, chartSourceById } from '../src/registry.js'
import type { ChartSource, LngLatBbox } from '../src/types.js'

// A typo'd id must fail the test, not silently return undefined, so lookups assert.
const src = (id: string): ChartSource => {
  const s = chartSourceById(id)
  assert.ok(s, `${id} must be in the catalog`)
  return s
}

const inBox = (b: LngLatBbox | undefined, lng: number, lat: number): boolean =>
  b !== undefined && lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]

/** Whether any of a source's coverage regions contains a point, for the drift guards below. */
const coveredBy =
  (source: ChartSource) =>
  (lng: number, lat: number): boolean =>
    (source.coverage ?? []).some((b) => inBox(b, lng, lat))

test('every source id is unique', () => {
  const ids = CHART_SOURCES.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('the public barrel exports exactly the documented runtime surface', async () => {
  // The package entry point is the contract. This checks the source tree in process;
  // scripts/package-smoke.mjs checks the packed tarball against the same shared list.
  const api: Record<string, unknown> = await import('../src/index.js')
  assert.deepEqual(Object.keys(api).sort(), [...EXPECTED_EXPORTS].sort())
})

test('every non-style source expands to an absolute https URL at its minzoom', () => {
  for (const s of CHART_SOURCES) {
    if (s.upstream.mode === 'style') continue
    const url = expandUpstreamUrl(s, s.minzoom, 0, 0)
    assert.ok(/^https:\/\//.test(url), `${s.id} expanded to ${url}`)
  }
})

test('the basemaps are the only style sources and each carries an allowed host', () => {
  const styles = CHART_SOURCES.filter((s) => s.upstream.mode === 'style')
  assert.deepEqual(
    styles.map((s) => s.id),
    ['basemap', 'basemap-dark']
  )
  for (const style of styles) {
    assert.ok(style.upstream.mode === 'style')
    // Both variants are served whole from one host, so an allowlist that grew a second entry means
    // the style graph moved and the proxy needs re-checking.
    assert.deepEqual(style.upstream.allowedHosts, ['tiles.openfreemap.org'], `${style.id} allowed hosts`)
    assert.ok(
      style.upstream.styleUrl.startsWith('https://tiles.openfreemap.org/styles/'),
      `${style.id} style URL must stay on the OpenFreeMap style path`
    )
  }
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
  assert.ok(bluetopo.upstream.mode === 'wmts')
  // Pin the whole template. Expanding it only at tile 0/0 elsewhere would not notice TILEROW and
  // TILECOL being swapped, nor a changed layer, matrix set, or format.
  assert.equal(
    bluetopo.upstream.urlTemplate,
    'https://nowcoast.noaa.gov/geoserver/gwc/service/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile' +
      '&LAYER=bluetopo:bathymetry&STYLE=&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}' +
      '&TILECOL={x}&FORMAT=image/png8'
  )
  // Expand at a tile whose x and y differ so a swap cannot pass.
  const expanded = new URL(expandUpstreamUrl(bluetopo, 5, 9, 20))
  assert.equal(expanded.searchParams.get('TILECOL'), '9')
  assert.equal(expanded.searchParams.get('TILEROW'), '20')
  assert.equal(expanded.searchParams.get('TILEMATRIX'), 'EPSG:3857:5')
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
  // NOAA ENC reports a global service envelope because it includes remote US chart coverage.
  assert.equal(inBox(src('depth-noaa-enc').bounds, 144.8, 13.5), true)
  assert.equal(inBox(src('depth-noaa-enc').bounds, -71.3, 41.5), true)
  // EMODnet reaches the Caribbean overseas territories, so its display envelope has to span the
  // Atlantic. Where it actually has data is the coverage list's job, which is asserted below; the
  // envelope only has to contain it.
  assert.equal(inBox(src('depth-emodnet').bounds, 0, 50), true)
  assert.equal(inBox(src('depth-emodnet').bounds, -62, 16), true)
  assert.equal(inBox(src('depth-emodnet').bounds, -140, 40), false)
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

test('group coherence is enforced when the catalog is built, not only by this suite', () => {
  // A consumer importing the catalog must not be able to receive a group whose members disagree,
  // so the invariant belongs to defineCatalog rather than to a test a consumer never runs.
  const source = src('depth-emodnet')
  const group = source.group
  assert.ok(group)
  assert.throws(
    () => assertGroupCoherence([source, { ...source, id: 'other', group: { ...group, title: 'Different' } }]),
    /two titles/
  )
  assert.throws(
    () => assertGroupCoherence([source, { ...source, id: 'other', attribution: 'Different attribution' }]),
    /disagree on attribution/
  )
})

test('BlueTopo bounds pin the US extent from the service capabilities (drift guard)', () => {
  const bluetopo = src('depth-bluetopo')
  assert.ok(bluetopo.bounds, 'depth-bluetopo must carry bounds')
  // South is a positive latitude and east is a negative longitude; a regression to the earlier
  // South Atlantic and European box fails here.
  assert.deepEqual(bluetopo.bounds, [-138.0, 16.786, -64.198, 59.55])
})

test('NOAA ENC coverage pins the chart regions from the ENC product catalog (drift guard)', () => {
  const enc = src('depth-noaa-enc')
  const quality = src('depth-noaa-enc-quality')
  assert.ok(enc.coverage, 'depth-noaa-enc must carry coverage')
  assert.deepEqual(quality.coverage, enc.coverage)
  // Pin every region, not just the count and the first box. A silently edited box in the middle of
  // the list would otherwise change what gets warmed with nothing to catch it.
  assert.deepEqual(enc.coverage, [
    [-100.8, 15.6, -64.3, 52.8],
    [-180, 30.5, -113.7, 81.6],
    [165.6, 48, 180, 68],
    [-179.3, 5, -154, 30],
    [-178.8, 15.6, -153.6, 28.8],
    [-166.4, 18, -150, 30],
    [-180, 18.7, -116.3, 38.4],
    [-154, 15, -116.5, 18.8],
    [-180, -7.5, -154.3, 18.8],
    [-173.8, -17.6, -165.2, -10],
    [131, 0, 173.6, 26],
    [-80.1, 8.7, -78, 9.9],
    [-64.5, -64.9, -63.9, -64.6],
    [-40, -78.4, -30, -75]
  ])
  // The first region is the densest one, so the upstream monitor samples a representative US tile.
  const covered = coveredBy(enc)
  assert.equal(covered(-76.2, 37.5), true, 'Chesapeake Bay must be covered')
  assert.equal(covered(144.8, 13.5), true, 'Guam must be covered')
  assert.equal(covered(-157.9, 21.3), true, 'Honolulu must be covered')
  assert.equal(covered(-146, 61), true, 'Prince William Sound must be covered')
  assert.equal(covered(0, 50), false, 'the English Channel must not be covered')
  assert.equal(covered(-15, -30), false, 'the South Atlantic must not be covered')
})

test('EMODnet coverage pins the sampled DTM regions (drift guard)', () => {
  const emodnet = src('depth-emodnet')
  // The bathymetry, its quality index, and its contours are the same grid, so they must warm the
  // same ground. Sharing one constant is what makes that true; this catches it being unshared.
  assert.deepEqual(src('depth-emodnet-quality').coverage, emodnet.coverage)
  assert.deepEqual(src('depth-emodnet-contours').coverage, emodnet.coverage)
  // Disjoint by construction, so each box is exactly the region its comment names and none is
  // implied by a neighbor. tileCountInBbox deduplicates overlaps, so this is for the reader.
  assert.deepEqual(emodnet.coverage, [
    [-37.5, 27.5, 40.0, 85.0],
    [40.0, 40.0, 45.0, 85.0],
    [-37.5, 15.0, -12.5, 27.5],
    [-72.5, 10.0, -57.5, 20.0],
    [32.5, 22.5, 37.5, 27.5],
    [35.0, 15.0, 42.5, 25.0],
    [42.5, 15.0, 45.0, 17.5]
  ])
  const covered = coveredBy(emodnet)
  assert.equal(covered(0, 50), true, 'the English Channel must be covered')
  assert.equal(covered(-28, 38.5), true, 'the Azores must be covered')
  assert.equal(covered(-16, 28.3), true, 'the Canaries must be covered')
  assert.equal(covered(-61.5, 16.2), true, 'Guadeloupe must be covered')
  assert.equal(covered(20, 63), true, 'the Gulf of Bothnia must be covered')
  // The advertised bbox reaches these; the sampled data does not, which is the whole point.
  assert.equal(covered(-71, 42.3), false, 'Boston must not be covered')
  assert.equal(covered(10, 20), false, 'the Sahara must not be covered')
})

test('NOAA MPA coverage pins the inventory regions (drift guard)', () => {
  const mpa = src('mpa-noaa')
  assert.deepEqual(mpa.coverage, [
    [-180, 12, -156, 30],
    [-156, 18, -154, 22],
    [176, 28, 180, 32],
    [-180, 44, -118, 76],
    [166, 46, 180, 58],
    [-130, 30, -116, 44],
    [-100, 24, -98, 28],
    [-98, 22, -64, 48],
    [-90, 48, -88, 50],
    [-76, 16, -64, 22],
    [142, 10, 150, 16],
    [142, 16, 172, 24],
    [-164, -4, -156, 8],
    [-178, -2, -174, 2],
    [-172, -16, -166, -10]
  ])
  const covered = coveredBy(mpa)
  // Every one of these sat outside the old [-180, 15, -60, 75] box, which is the bug being fixed.
  assert.equal(covered(144.75, 13.45), true, 'Guam must be covered')
  assert.equal(covered(145.75, 15.2), true, 'the Northern Marianas must be covered')
  assert.equal(covered(-170.7, -14.3), true, 'American Samoa must be covered')
  assert.equal(covered(166.6, 19.3), true, 'Wake Island must be covered')
  assert.equal(covered(-162.1, 5.9), true, 'Palmyra Atoll must be covered')
  // And these were already inside it and must stay covered.
  assert.equal(covered(-121.9, 36.6), true, 'Monterey Bay must be covered')
  assert.equal(covered(-81.8, 24.5), true, 'the Florida Keys must be covered')
  assert.equal(covered(-176.6, 51.9), true, 'the Aleutians must be covered')
  assert.equal(covered(0, 50), false, 'the English Channel must not be covered')
})

test('only time-dynamic sources carry a TTL, and every one of them caps its zoom', () => {
  const volatile = CHART_SOURCES.filter((s) => s.maxAgeSeconds !== undefined)
  assert.deepEqual(
    volatile.map((s) => s.id),
    [
      'weather-radar-conus',
      'weather-radar-alaska',
      'weather-radar-hawaii',
      'weather-radar-caribbean',
      'weather-tropical',
      'weather-alerts-us',
      'ocean-sst-global'
    ]
  )
  for (const s of volatile) {
    assert.ok(
      s.maxAgeSeconds !== undefined && Number.isSafeInteger(s.maxAgeSeconds) && s.maxAgeSeconds > 0,
      `${s.id} TTL must be a positive safe integer`
    )
    // A cache re-fetches these on a timer, so the tile count is a recurring cost rather than a
    // one-time warm. The chart-display ceiling would multiply that by hundreds.
    assert.ok(s.maxzoom <= 10, `${s.id} maxzoom ${s.maxzoom} is too deep for a source that re-fetches on a timer`)
  }
  // Bathymetry and chart display are static: a TTL there would make a cache re-fetch a grid that
  // changes on a multi-year cycle.
  for (const id of ['depth-gebco', 'depth-noaa-enc', 'depth-bluetopo', 'seascape-dem', 'basemap']) {
    assert.equal(src(id).maxAgeSeconds, undefined, `${id} must not carry a TTL`)
  }
})

test('every catalog source carries a positive safe-integer fallbackTileBytes', () => {
  // Locks the estimateBytes invariant that the mode and default fallbacks stay unreachable for
  // catalog sources; a new source without fallbackTileBytes would silently shift onto them.
  for (const s of CHART_SOURCES) {
    assert.ok(
      s.fallbackTileBytes !== undefined && Number.isSafeInteger(s.fallbackTileBytes) && s.fallbackTileBytes > 0,
      `${s.id} must carry a positive safe-integer fallbackTileBytes`
    )
  }
})
