# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<a id="v010"></a>

## [0.1.0] - 2026-06-30

The first release of the shared chart-source catalog, carved out so the Binnacle chartplotter
render config and the Chart Locker tile-cache proxy allowlist derive from one definition and never
drift. Data and pure helpers only: no MapLibre, no Signal K, and no Node or browser APIs.

### Added

- **Source registry (`CHART_SOURCES`).** The shared allowlist of every raster overlay and the
  vector basemap the Binnacle chartplotter renders, with upstream URL templates, tile size, zoom
  range, and optional geographic bounds, so the tile-cache proxy allowlist and the webapp render
  config stay in sync from one definition. The `ChartSource` and `UpstreamTemplate` types describe
  the five upstream modes: XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and vector style.
- **Web Mercator tile math.** `webMercatorTileBounds` returns the EPSG:3857 bounds of an XYZ tile,
  matching MapLibre's `{bbox-epsg-3857}` substitution and bit-exact with the Rust container copy so
  the proxied and direct tile requests produce the same cache key. `MAX_MERCATOR_LAT` is the Web
  Mercator latitude limit that callers clamp to before projecting.
- **Tile enumeration helpers.** `tileForLngLat` returns the integer Web Mercator tile that contains
  a longitude-latitude point at a given zoom level. `tilesInBbox` enumerates every tile covering a
  bounding box over a zoom range, clipped to the source's declared bounds and the Mercator latitude
  limit, with antimeridian and degenerate-box guards. `tileCountInBbox` returns the tile count for
  the same region without allocating the full list, used as an upper-bound gate for the region byte
  estimate.
- **URL expansion helpers.** `expandUpstreamUrl` builds the upstream tile URL for any source mode
  (XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and style). `proxyTileTemplate` builds the plugin-facing
  tile template the chartplotter renders when the Chart Locker tile cache is present.
- **Shared tile-count byte estimate.** `estimateBytes(sourceIds, bbox, zoomRange, perSourceAvgBytes)`
  returns the upper-bound byte total for a region download: for each known source it multiplies
  `tileCountInBbox` by that source's average tile size, falling back to the `DEFAULT_TILE_BYTES`
  constant (25,000) when a source has never been cached. Exporting one implementation lets the Chart
  Locker plugin and the Binnacle webapp panel share the same math, so the server-side budget
  re-validation agrees with the panel estimate. Unknown source ids are skipped.
