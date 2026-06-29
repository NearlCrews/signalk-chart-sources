# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Shared tile-count byte estimate.** `estimateBytes(sourceIds, bbox, zoomRange, perSourceAvgBytes)`
  returns the upper-bound byte total for a region download: for each known source it multiplies
  `tileCountInBbox` by that source's average tile size, falling back to the new `DEFAULT_TILE_BYTES`
  constant (25,000) when a source has never been cached. Exporting one implementation lets the Chart
  Locker plugin and the Binnacle webapp panel share the same math, so the server-side budget
  re-validation agrees with the panel estimate. Unknown source ids are skipped.

<a id="v010"></a>

## [0.1.0] - 2026-06-28

### Added

- **Tile enumeration helpers.** `tileForLngLat` returns the integer Web Mercator tile that
  contains a longitude-latitude point at a given zoom level. `tilesInBbox` enumerates every
  tile covering a bounding box over a zoom range, clipped to the source's declared bounds and
  the Mercator latitude limit, with antimeridian and degenerate-box guards. `tileCountInBbox`
  returns the tile count for the same region without allocating the full list, used as an
  upper-bound gate for the prewarm byte estimate in the Binnacle Companion.
- **Source registry (`CHART_SOURCES`).** The shared allowlist of every raster and vector
  source the Binnacle chartplotter renders, with upstream URL templates, tile size, zoom
  range, and optional geographic bounds, so the companion proxy allowlist and the webapp
  render config stay in sync from one definition.
- **URL expansion helpers.** `expandUpstreamUrl` builds the upstream tile URL for any source
  mode (XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and style). `proxyTileTemplate` builds the
  plugin-facing tile template the chartplotter uses when the companion is present.
