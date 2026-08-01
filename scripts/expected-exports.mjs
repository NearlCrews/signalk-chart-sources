/**
 * The complete runtime export surface of the published package.
 *
 * Shared by the test suite, which checks the source tree in process, and by the package smoke test,
 * which checks the packed tarball from a separate process. The two comparisons are independent and
 * both worth running; the list of names they compare against is not, so it lives here. Plain
 * JavaScript because scripts/package-smoke.mjs runs on bare node with no TypeScript loader.
 */
export const EXPECTED_EXPORTS = [
  'CHART_SOURCES',
  'DEFAULT_MAX_ENUMERATED_TILES',
  'DEFAULT_TILE_BYTES_BY_MODE',
  'MAX_MERCATOR_LAT',
  'MAX_TILE_ZOOM',
  'chartSourceById',
  'estimateBytes',
  'expandUpstreamUrl',
  'iterateTilesInBbox',
  'proxyTileTemplate',
  'tileCountInBbox',
  'tileForLngLat',
  'tilesInBbox',
  'validateChartSource',
  'webMercatorTileBounds'
]
