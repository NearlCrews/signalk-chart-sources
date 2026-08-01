# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Release entries describe behavior at the time of that release. See the README for the current API
contract and the Unreleased section for pending compatibility changes.

## [Unreleased]

## [0.7.0] - 2026-08-01

### Added

- Add twenty sources. A dark basemap (OpenFreeMap Dark) for night use. Seven NOAA nowCOAST weather
  and ocean overlays: base reflectivity radar mosaics for the lower 48, Alaska, Hawaii, and the
  Caribbean, active tropical cyclones, NWS watches and warnings, and global sea surface temperature.
  Two GEBCO facets, flat color elevation and measured-soundings-only. EMODnet depth contours. Four
  seabed-infrastructure overlays from EMODnet Human Activities: power cables, telecom cables,
  pipelines, and wind farms. Monthly AIS vessel density. Three more Marine Regions jurisdiction
  layers, the 24 nm contiguous zone, the high seas, and IHO sea areas, plus UNESCO World Heritage
  marine sites, which is the catalog's first worldwide protected-area layer.
- Add an optional `maxAgeSeconds` to `ChartSource`, declaring how long a fetched tile stays usable. A
  cache must treat an older tile as expired and must not warm the source ahead of time, because a
  stored weather frame is wrong before anyone sails into it. Only the weather and ocean sources carry
  it, and each also caps its zoom well short of the chart-display ceiling, since a source that
  re-fetches on a timer pays its tile count over and over.
- Accept whole `ChartSource` values as well as catalog ids in `estimateBytes`, so a consumer can
  price a source it defined itself. A supplied source is checked before its id is read.
- Add an optional `tileJsonUrl` to the `xyz` upstream, naming the TileJSON a service publishes for a
  tileset. A tile template carries no metadata, so this is what lets the monitor check a transcribed
  attribution against what the service currently serves.
- Compare every XYZ source that declares a TileJSON against it on each upstream monitor run, and
  compare every WMS source's `bounds` against the envelope its own layer advertises. The Seascape
  attribution drift below went unnoticed because nothing checked it, and nine of the envelopes added
  in this release would have had the same gap. The bounds check found a real one immediately: the
  EMODnet quality and contour facets reach less far than the bathymetry whose envelope they had
  been given.

### Changed

- Reject ports, IP address literals, and loopback names in every URL field rather than only in a
  style `allowedHosts` entry. Address literals are rejected wholesale rather than range by range,
  which leaves the private-range table in the one place that can act on it. A hostname still has to
  be checked against the address it resolves to, which only the consuming server can do.
- Replace the `mpa-noaa` bounding box with fifteen coverage regions derived from the MPA inventory's
  own geometry. The previous box excluded Guam, the Northern Mariana Islands, American Samoa, Wake
  Island, and the Pacific Remote Islands outright, while enumerating about 42 percent more tiles
  than the derived regions do.
- Replace the EMODnet bathymetry bounding box with seven coverage regions derived by sampling the
  live digital terrain model. The previous box was the 2016-era extent and clipped the Azores,
  Madeira, the Canaries, and the Caribbean overseas territories; the service's own advertised box is
  the tiling grid rather than the data, and warming it whole would cover the Sahara.
- Give the two EMODnet Human Activities protected-area overlays their own advertised envelopes
  instead of sharing the bathymetry's, which fit neither.
- Transcribe the shortened Seascape attribution the service now publishes, in both the raster and
  vector sources.
- Strip trailing slashes from a WMS `base` when expanding a tile URL, matching what ArcGIS already
  did, so one base cannot produce two spellings of the same request.
- Move the `ZXY` type to `types.ts` with the other domain types. It is still exported from
  `mercator.ts` and from the package entry point.

## [0.6.0] - 2026-07-31

### Added

- Validate that WMS `LAYERS` contains no empty entry and that `STYLES` is either empty or names one
  style per requested layer, matching how WMS 1.3.0 pairs the two lists by position.
- Reject invisible characters in URL fields. IDNA discards them, so a host carrying one validated as
  written while resolving somewhere else.
- Pin the public export surface in both the test suite and the packed-tarball smoke test, from one
  shared list, and exercise the main helpers and every public type against the installed package.
- Verify the WMTS tile matrix top-left corner against the projection origin the tile math assumes,
  and follow array-form `sprite` and geojson `data` references when discovering style hosts.
- Report every drifted source from one upstream monitor run instead of stopping at the first, and
  close the drift tracking issue once the upstreams are healthy again.

### Changed

- Write the WMS and ArcGIS `BBOX` parameter in plain decimal. Tile edges on the projection origin
  arrive as floating-point residue and previously rendered in exponential notation, which the OGC
  `BBOX` grammar does not admit.
- Validate inputs in `iterateTilesInBbox` when it is called rather than when the returned generator
  is first advanced, so an abandoned iterator still fails closed. `maxTiles` is now checked before
  any counting work.
- Reject a bounding box whose west equals its east. Such a box has no width, but was read through the
  antimeridian wrap and silently became worldwide coverage.
- Reject `;` and `=` in WMS layer, style, and format values, and backslashes in `proxyTileTemplate`
  plugin bases.
- Reject C1 control characters in source text, and read `estimateBytes` averages from own properties
  only so an inherited entry cannot stand in for a measurement.
- Build the upstream URL from a snapshot of the validated source, so a source defined with accessor
  properties cannot return one value to the validator and another to the builder.
- Enforce group title and attribution coherence when the catalog is built rather than only in tests.
- Truncate rejected input echoed into validation errors.
- Return a readonly tile from `tileForLngLat`.

### Removed

- Remove the `Bbox` type alias. `LngLatBbox` names the units and is the only spelling the library
  now uses.
- Remove the `DEFAULT_TILE_BYTES` export. `estimateBytes` could never reach it, because
  `DEFAULT_TILE_BYTES_BY_MODE` is total over the upstream modes.

### Fixed

- Close a gap in the workflow action-pin check that passed any `uses:` reference without an `@`, add
  an allowlist for job-level permission escalations, and read each checkout step from the parsed
  workflow so one step's credential setting cannot satisfy another's.
- Grant issue write access only to the upstream monitor job that files the tracking issue, leaving
  the job that installs dependencies and parses capability documents read-only.
- Surface child-process output when the package smoke test fails, and assert that `README.md` and
  `LICENSE` are packed.
- Release the response body reader when the upstream monitor trips its size cap, honor the
  positional `STYLES` pairing when verifying WMS capabilities, and stop treating an absent
  `content-length` header as a declared length of zero.
- Keep the CI whitespace lane working when the base commit is missing after a force push.

### Performance

- Cut per-tile URL expansion time by roughly two to seven times, by removing the string copies that
  source revalidation made for every text field on every tile and by building the BBOX parameter
  without an intermediate array. The gain scales with attribution length, so the sources carrying
  long attributions benefit most.

## [0.5.0] - 2026-07-27

### Added

- Carry disjoint `coverage` regions on both NOAA ENC sources, derived from the NOAA ENC product
  catalog, so tile counts, cache warming, and download estimates track actual chart coverage instead
  of the global service envelope.
- Open or update a tracking issue when the scheduled upstream monitor fails, so upstream drift stays
  visible beyond the workflow failure email.

### Changed

- Reject bare trailing `?` and `#` markers in upstream URLs, template tokens in XYZ and WMTS hosts,
  `+` in WMS layer, style, and format values, and ports in style allowed hosts.
- Reject duplicate `{z}`, `{x}`, and `{y}` tokens in XYZ and WMTS templates, and reject non-empty
  whitespace-only text in optional source fields such as attribution.
- Validate `proxyTileTemplate` plugin bases against whitespace, control characters, `?`, `#`, and
  braces.
- Count duplicate source ids once in `estimateBytes`.
- Raise the TypeScript compile target to ES2023 and drop the DOM type library for the Node.js 22
  floor.

### Fixed

- Freeze catalog objects before recursing so a cyclic reference cannot loop, and freeze
  symbol-keyed properties.
- Bound XML entity expansion in the upstream monitor parser.
- Extract the `npm pack` JSON report defensively in the package smoke test so npm lifecycle banners
  cannot corrupt it.
- Check action pins on every `uses:` step form, including named steps, in the workflow invariant
  script, and serialize upstream monitor runs with a concurrency group.

## [0.4.0] - 2026-07-17

### Added

- Add a Binnacle-style repository toolchain with Biome, Markdown linting, spelling, Knip dead-code
  and cycle checks, Publint, workflow invariant validation, aggregate verification scripts, and a
  stable `CI success` status for repository rules.
- Parse WMS and WMTS capabilities structurally, sample representative in-coverage tiles, and verify
  the exact transitive style and TileJSON host graph in the scheduled upstream monitor. Bound live
  response bodies and retry one transient fetch failure.
- Add strict TypeScript compiler checks for unused code, implicit returns, fallthrough, overrides,
  unreachable code, property access, labels, and path casing.

### Changed

- Accept `unknown` in `validateChartSource`, validate the complete runtime structure, and narrow
  successful values to `ChartSource`.
- Bound source strings and collections, reject credentials, fragments, unsupported template tokens,
  WMS query injection, base URL queries, duplicate style hosts, and unknown upstream modes.
- Normalize ArcGIS base trailing slashes in TypeScript and the Rust Chart Locker mirror.
- Run package metadata and installed-consumer checks against the exact tarball retained for npm
  publication, and include the changelog in the published package.
- Publish only stable releases whose version tag commit is reachable from `main`, serialize duplicate
  release runs, and request npm provenance for the verified tarball.
- Update all workflows to the reviewed `actions/setup-node` v7 commit and allow Dependabot to report
  major updates for compatibility review.

### Fixed

- Normalize trailing slashes with a linear scan to prevent polynomial-time processing of hostile
  ArcGIS and plugin base strings.
- Reject `[180, south, -180, north]` as a zero-longitude-span bbox in counting, array enumeration,
  lazy iteration, source validation, and the Rust tile-cache mirror.
- Document and test the existing inclusive tile-boundary behavior used for conservative warming.

## [0.3.1] - 2026-07-13

### Fixed

- Prefix the verified tarball path with `./` so npm 12 treats it as a local package instead of
  GitHub shorthand during publication.

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

[Unreleased]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/NearlCrews/signalk-chart-sources/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NearlCrews/signalk-chart-sources/releases/tag/v0.1.0
