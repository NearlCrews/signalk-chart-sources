# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release entries describe behavior at the time of that release. See the README for the current API
contract and the Unreleased section for pending compatibility changes.

## [Unreleased]

## [0.3.0] - 2026-07-13

### Added

- Antimeridian-aware tile counting and enumeration, disjoint source coverage, lazy tile iteration,
  defensive enumeration limits, unit-specific bbox type names, and public source validation.
- Conservative per-source and per-mode first-download estimates with strict numeric and source-id
  validation.
- Property-style tile invariants, package-tarball smoke tests, coverage thresholds, and a scheduled
  upstream service and capabilities monitor.
- Repository-specific contributor guidance in `AGENTS.md`.

### Changed

- `CHART_SOURCES` and all nested catalog values are deeply readonly and frozen.
- Public tile helpers reject invalid coordinates, zooms, boxes, and source metadata explicitly.
- NOAA ENC bounds now match the geographic envelope in the live WMS capabilities.
- The supported Node.js floor is 22, and CI covers Node.js 22, 24, and 26.
- npm package exports are explicit, and the package declares itself side-effect-free.
- Release publishing uses a tested tarball, pinned GitHub Actions, and a protected environment. The
  workflow is prepared for npm trusted publishing without a long-lived write token.
- Development uses TypeScript 7.0.2, `@types/node` 26.1.1, `tsx` 4.23.1, and an explicit allowlist
  for the `esbuild` install script required by `tsx`.

### Migration

- Node.js 20 consumers must upgrade to Node.js 22 or newer.
- Treat `CHART_SOURCES`, nested source objects, bbox tuples, zoom tuples, and host arrays as readonly.
- Handle `RangeError` or `TypeError` from invalid geometry, coordinates, zooms, source definitions,
  source ids, averages, enumeration limits, and unsafe numeric totals.
- Review `tilesInBbox` callers against the 1,000,000-tile default limit. Use `tileCountInBbox` before
  enumeration and use `iterateTilesInBbox` for bounded streaming.
- Expect antimeridian-crossing boxes to return deduplicated east-edge and west-edge tiles instead of
  an empty result.
- Do not rely on unknown source ids being skipped by `estimateBytes`; they now fail closed.

### Fixed

- Large valid regions can no longer crash `tilesInBbox` through an impossible array allocation.
- Invalid or missing estimate statistics can no longer return negative, non-finite, or unsafe totals.
- Mutating exported catalog data can no longer desynchronize `CHART_SOURCES` and `chartSourceById`.

<a id="v021"></a>

## [0.2.1] - 2026-07-07

### Added

- **Seascape bathymetry.** Two new catalog entries, `seascape-dem` (a raster-dem elevation source,
  512 px tiles) and `seascape-vector` (contours, soundings, and drying areas), both plain XYZ
  templates against `tiles.openwaters.io`, so the Chart Locker proxy allowlist recognizes the ids
  the Binnacle chartplotter now renders.

<a id="v020"></a>

## [0.2.0] - 2026-07-04

A cleanup release: the public API gains named types and an id lookup, the test suites now
type-check under the same strict settings as the library, and the registry carries more drift
guards.

### Added

- **Named tuple types.** `Bbox` (`[minX, minY, maxX, maxY]`; geographic boxes are
  `[west, south, east, north]` degrees) and `ZoomRange` (the inclusive `[minzoom, maxzoom]` pair)
  name the tuples every helper already took, and `ChartGroup` names the group descriptor a source
  and its facets share. All three are exported, so consumers no longer restate the shapes by hand.
- **`chartSourceById(id)`.** The catalog lookup by stable id, now shared by `estimateBytes` and
  available to consumers instead of ad hoc `CHART_SOURCES.find` scans.
- **Strict type-checking for the tests.** `npm run typecheck` now also checks `test/` under the
  library's strict compiler settings through `tsconfig.test.json`, and the suites share one
  `makeSource` fixture. New tests pin the OpenSeaMap, NOAA MPA inventory, and basemap upstreams,
  the group title and attribution invariants, the longitude and latitude ranges of every bounded
  source, the zero estimate for a bbox outside a source's bounds, and the out-of-range longitude
  clamp in `tileForLngLat`.

### Changed

- `substituteZXY` hoists its token regex to module scope and drops a per-call lookup object.
- `clipBbox` drops a redundant antimeridian guard: the single width and height check at the end
  rejects those boxes, and a comment now explains why that is sufficient.
- The NOAA bounds constants follow one naming scheme (`NOAA_ENC_BOUNDS`, `NOAA_MPA_BOUNDS`), and
  the registry cites the WMTS GetCapabilities tile matrix that justifies the BlueTopo 512 pixel
  tile size.
- The npm keywords now list all five upstream modes.
- Dev dependencies: `@types/node` added (pinned to the Node 20 engines floor), and the `tsx` and
  `typescript` ranges brought current.

### Fixed

- A stale comment in `src/types.ts` called the tile cache by its old working name; it now says
  Chart Locker like every other file.

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

[Unreleased]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NearlCrews/signalk-chart-sources/releases/tag/v0.1.0
