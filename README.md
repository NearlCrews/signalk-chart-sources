# signalk-chart-sources

[![npm version](https://img.shields.io/npm/v/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![npm downloads](https://img.shields.io/npm/dm/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![CI](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

The shared marine chart-source catalog and Web Mercator tile math for the Binnacle chartplotter
and the Chart Locker tile cache.

> This package is a dependency of
> [signalk-chart-locker](https://github.com/NearlCrews/signalk-chart-locker) and
> [signalk-binnacle](https://github.com/NearlCrews/signalk-binnacle). Most users receive it as a
> transitive dependency rather than installing it directly.

## Purpose

`signalk-chart-sources` keeps chart rendering, tile-cache authorization, tile counting, and download
planning on one catalog. The package contains static data and pure helpers. It has no runtime
dependencies, performs no I/O, and uses no platform-specific Node.js or browser APIs.

The package provides:

- An immutable catalog covering XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and vector-style sources.
- Validated upstream and proxy URL construction.
- Bit-exact Web Mercator tile bounds shared with the Rust tile-cache implementation.
- Antimeridian-aware counting and bounded or lazy tile enumeration.
- Conservative download planning estimates with fail-closed input handling.
- TypeScript declarations for every public value and helper.

## Installation

Node.js 22 or newer is required.

```bash
npm install signalk-chart-sources
```

The package is ESM-only. Import everything from the package root:

```ts
import { chartSourceById, tileCountInBbox } from 'signalk-chart-sources'
```

## Public API

### Catalog

- `CHART_SOURCES`: the deeply frozen, readonly catalog.
- `chartSourceById(id)`: return the immutable source with that stable id, or `undefined`.
- `validateChartSource(source)`: validate a built-in or consumer-supplied source and throw on an
  invalid runtime shape, id, zoom range, URL, bounds, coverage, fallback size, or mode-specific
  requirement. Its assertion signature accepts `unknown` and narrows successful values to
  `ChartSource`.
- `ChartSource`, `UpstreamTemplate`, and `ChartGroup`: public catalog types.

Each `ChartSource` may contain:

- `bounds`: one geographic display envelope, omitted for worldwide sources.
- `coverage`: optional warming and estimate regions. When present, tile helpers use it instead of
  `bounds`. Regions need not be disjoint, because tile helpers deduplicate overlaps. The NOAA ENC
  sources carry coverage regions derived from the NOAA ENC product catalog, so their counts and
  estimates track actual chart coverage instead of the global service envelope.
- `fallbackTileBytes`: a conservative first-download estimate used until a measured average exists.
- `vectorMaxzoom`: the native vector-data maximum, below the visual overzoom ceiling when needed.
- `upstream.tileJsonUrl` (`xyz` only): the TileJSON the service publishes for the tileset, when it
  publishes one. A tile template carries no metadata of its own, so this is what lets the scheduled
  monitor check the transcribed attribution and zoom ceiling against what the service serves today.
- `maxAgeSeconds`: how long a fetched tile stays usable. Absent means the source is static and a
  cache may keep a tile indefinitely. Present means the source is time-dynamic, and a cache must
  treat an older tile as expired and must not warm the source ahead of time: pre-fetching weather
  radar stores frames that are already wrong by the time anyone reads them. Bathymetry and chart
  display never carry it; the `weather-*` and `ocean-*` sources always do.

Catalog sources that are time-dynamic also stop well short of the chart-display zoom ceiling. A cache
re-fetches them on a timer, so their tile count is a recurring cost rather than a one-time warm, and
the products are coarse regardless: the NEXRAD mosaic is about 1 km and the sea-surface temperature
field is a daily multi-kilometer analysis.

Catalog values are frozen at runtime and readonly in TypeScript. Consumers must derive local display
metadata instead of mutating catalog entries.

### Coordinate types

- `LngLatBbox`: `[west, south, east, north]` in degrees.
- `MercatorBbox`: `[minX, minY, maxX, maxY]` in EPSG:3857 meters.
- `ZoomRange`: inclusive `[minzoom, maxzoom]` integers.
- `ZXY`: readonly `{ z, x, y }` tile coordinate.
- `TileEnumerationOptions`: currently `{ maxTiles?: number }`.

A longitude-latitude box crosses the antimeridian when `west > east`. Degenerate boxes, invalid
latitudes or longitudes, and non-finite values throw `RangeError`. Both `[180, south, -180, north]`
and any box whose west equals its east have a zero longitude span and are invalid, the first even
though its west value is greater than its east value.

### Tile math

- `webMercatorTileBounds(z, x, y)`: return the EPSG:3857 bounds of one valid XYZ tile.
- `tileForLngLat(lng, lat, z)`: return the readonly `{ x, y }` of the integer tile containing a
  finite point, without the `z` that `ZXY` carries. Latitude clamps to `MAX_MERCATOR_LAT`, and finite
  longitudes outside `[-180, 180]` clamp to an edge tile.
- `tileCountInBbox(source, bbox, zoomRange)`: count distinct tiles without allocating the tile list.
- `tilesInBbox(source, bbox, zoomRange, options)`: return distinct tiles as an array. The default
  `maxTiles` is `DEFAULT_MAX_ENUMERATED_TILES`, currently 1,000,000.
- `iterateTilesInBbox(source, bbox, zoomRange, options)`: lazily yield the same distinct tiles.
  Inputs and the total are checked against `maxTiles` when the call is made, not when the generator
  is first advanced, so a rejected request fails closed even if the caller never iterates.
- `MAX_MERCATOR_LAT`: the Web Mercator latitude limit, approximately 85.0511 degrees.
- `MAX_TILE_ZOOM`: the highest accepted zoom, currently 30.
- `DEFAULT_MAX_ENUMERATED_TILES`: the defensive default enumeration limit.

Tile helpers validate source metadata, coordinates, zooms, zoom ordering, and safe-integer counts.
Invalid inputs throw instead of returning partial or ambiguous results. A wrong shape or type throws
`TypeError`, and a value outside its permitted range throws `RangeError`, so a source definition can
raise either depending on which part of it is wrong. Catch both at request and UI boundaries.

Geographic bbox edges are inclusive for conservative warming, and that inclusivity is directional
because the tile index always floors. A box whose east or south edge lands exactly on a tile boundary
also covers the tile beyond that edge; a box whose west or north edge lands on a boundary does not
reach back across it.

### URL construction

- `expandUpstreamUrl(source, z, x, y)`: validate the source and coordinate, substitute XYZ or WMTS
  tokens, construct WMS or ArcGIS parameters, or return a style URL.
- `proxyTileTemplate(pluginBase, sourceId)`: normalize trailing slashes on the plugin base, validate
  the base and the path-safe source id, and return the Chart Locker tile template.

`expandUpstreamUrl` only constructs a string. The consuming application performs the network request.
Source validation requires bounded HTTPS URLs without credentials or fragments, including a bare
trailing `#`. URL fields also reject invisible characters, because IDNA discards them and a host
carrying one reads as a different host than the one the request reaches. XYZ and WMTS templates may
contain only `{z}`, `{x}`, and `{y}` tokens, each exactly once, the host may not contain tokens, and
no other brace may survive expansion. WMS and ArcGIS base URLs may not contain query parameters or a
bare trailing `?`, WMS version must be `1.3.0`, and WMS layer, style, and format values may not
inject query delimiters, `+`, `;`, or `=`. WMS `LAYERS` may not contain an empty entry, and `STYLES`
must be either empty or name one style per requested layer, as WMS 1.3.0 pairs the two lists by
position. Optional text fields accept the empty string but reject non-empty whitespace-only values.
Style hosts are deduplicated case-insensitively and must authorize the style URL itself. Plugin bases
reject whitespace, control characters, `?`, `#`, braces, and backslashes.

Every URL field rejects ports, IP address literals, and loopback names. A chart source names a public
service, so `https://host:8443/wms`, `https://127.0.0.1/wms`, `https://[::1]/wms`, and
`https://localhost/wms` all throw, as do the octal and integer spellings of an address that the URL
parser rewrites to a dotted quad. Address literals are rejected wholesale rather than range by range,
which keeps the private-range table in the one place that can act on it.

That is the definition-time half of an SSRF policy, not the whole of it. A hostname still resolves at
request time, and a public name can resolve, or rebind, to a private address. A server that proxies
these sources must check the resolved address before connecting; this package cannot.

Only a `style` source carries a host allowlist. For XYZ, WMTS, WMS, and ArcGIS sources, validation
constrains the shape of the URL but not its destination, because the catalog is what decides which
hosts are legitimate. An application that accepts source definitions from anywhere other than this
catalog must apply its own host policy on top of `validateChartSource`.

The WMS and ArcGIS `BBOX` parameter is always written in plain decimal. A tile edge that falls on the
projection origin arrives from the tile math as floating-point residue near zero, which would
otherwise render in exponential notation that the OGC `BBOX` grammar does not admit.

### Download planning

- `estimateBytes(sources, bbox, zoomRange, perSourceAvgBytes)`: multiply distinct tile counts by a
  positive measured average or a conservative first-download fallback. Each entry is either a
  catalog id or a whole `ChartSource`, so a consumer can price a source it defined itself without
  registering it. A supplied source is validated before its id is read. Entries resolving to the
  same id are counted once, the first occurrence winning.
- `DEFAULT_TILE_BYTES_BY_MODE`: per-mode fallbacks for XYZ, WMTS, WMS, ArcGIS, and style. A source
  without its own `fallbackTileBytes` falls back to the entry for its mode.

`perSourceAvgBytes` is read by own property only, so an average inherited through the prototype chain
is ignored rather than treated as a measurement. Unknown source ids, invalid measured averages, and
totals beyond `Number.MAX_SAFE_INTEGER` throw.
Compressed tile sizes vary, so no average is a mathematical upper bound. Servers must enforce actual
transferred-byte and tile-count limits while processing a download.

## Examples

Count and estimate a download:

```ts
import {
  chartSourceById,
  estimateBytes,
  tileCountInBbox,
  type LngLatBbox,
  type ZoomRange
} from 'signalk-chart-sources'

const source = chartSourceById('depth-gebco')
if (!source) throw new Error('GEBCO source is unavailable')

const region: LngLatBbox = [-122.5, 37.7, -122.3, 37.9]
const zooms: ZoomRange = [0, 12]
const tileCount = tileCountInBbox(source, region, zooms)
const plannedBytes = estimateBytes([source.id], region, zooms, {})
```

Enumerate an antimeridian-crossing region without allocating an array:

```ts
import { chartSourceById, iterateTilesInBbox, type LngLatBbox } from 'signalk-chart-sources'

const source = chartSourceById('seamark')
if (!source) throw new Error('Seamark source is unavailable')

const region: LngLatBbox = [170, -10, -170, 10]
for (const tile of iterateTilesInBbox(source, region, [3, 8], { maxTiles: 100_000 })) {
  // Queue tile.z, tile.x, and tile.y for bounded processing.
}
```

## Source catalog

The catalog currently holds 36 sources:

| Category | Stable ids | Upstream modes |
| --- | --- | --- |
| Bathymetry | `depth-gebco`, `depth-gebco-color`, `depth-gebco-measured`, `depth-emodnet`, `depth-emodnet-quality`, `depth-emodnet-contours`, `depth-bluetopo`, `depth-bluetopo-uncertainty`, `depth-noaa-enc`, `depth-noaa-enc-quality`, `seascape-dem`, `seascape-vector` | WMS, WMTS, XYZ |
| Seamarks | `seamark` | XYZ |
| Maritime boundaries | `bound-eez`, `bound-12nm`, `bound-24nm`, `bound-high-seas`, `bound-iho` | WMS |
| Marine protected areas | `mpa-emodnet`, `mpa-natura2000`, `mpa-noaa`, `mpa-unesco` | WMS, ArcGIS |
| Seabed infrastructure | `infra-power-cables`, `infra-telecom-cables`, `infra-pipelines`, `infra-wind-farms` | WMS |
| Traffic | `traffic-vessel-density` | WMS |
| Weather and ocean | `weather-radar-conus`, `weather-radar-alaska`, `weather-radar-hawaii`, `weather-radar-caribbean`, `weather-tropical`, `weather-alerts-us`, `ocean-sst-global` | WMS |
| Basemap | `basemap`, `basemap-dark` | Style |

Every source in the weather and ocean row carries `maxAgeSeconds`. They are the only ones that do,
and a cache must expire and never pre-warm them. See the `maxAgeSeconds` note under the catalog API
above.

Source ids, upstream layer names, styles, URLs, dimensions, bounds, and attribution are load-bearing
configuration. The scheduled upstream monitor samples every source and compares selected capability
metadata. It parses configured WMS layers, styles, formats, CRS support, WMTS matrix definitions, and
the complete transitive style and TileJSON host graph. Verify the upstream service before changing
catalog data.

## Migrating to 0.7.0

Three behaviors move for consumers:

- Sources may carry `maxAgeSeconds`. A cache must expire those tiles and must never pre-warm them.
  Only the weather and ocean sources carry it.
- Every URL field rejects ports, IP address literals, and loopback names, not just style
  `allowedHosts`. A consumer-supplied source pointing at one now throws.
- `depth-emodnet`, its facets, and `mpa-noaa` carry derived `coverage` regions, so their tile counts
  and estimates change. `mpa-noaa` falls about 42 percent while gaining the Pacific territories its
  previous box excluded.

`estimateBytes` also accepts whole `ChartSource` values alongside ids, which is additive.

## Migrating to 0.6.0

Version 0.6.0 includes intentional compatibility changes:

- The `Bbox` type alias and the `DEFAULT_TILE_BYTES` export are removed. Use `LngLatBbox`, which
  names its units, and `DEFAULT_TILE_BYTES_BY_MODE`, which `estimateBytes` actually consults.
- A box whose west equals its east is rejected as degenerate. It previously read as an antimeridian
  wrap and silently became worldwide coverage.
- `iterateTilesInBbox` validates when it is called rather than when the generator is first advanced,
  so an abandoned iterator still fails closed.
- The WMS and ArcGIS `BBOX` parameter is written in plain decimal, which changes the request URL for
  tiles whose edges fall on the projection origin.
- Consumer-supplied WMS sources must pair `STYLES` with `LAYERS` by position, and validation rejects
  more characters: `;` and `=` in WMS values, backslashes in plugin bases, C1 controls in source
  text, and invisible characters in URLs.
- `tileForLngLat` returns a readonly tile, and `estimateBytes` reads measured averages from own
  properties only.

Consumers should type-check against the release before upgrading and review every call that accepts
untrusted geometry, statistics, or source ids. See [MIGRATING.md](MIGRATING.md) for an upgrade
checklist and the earlier 0.5.0, 0.4.0, and 0.3.x migrations.

## Development

```bash
git clone https://github.com/NearlCrews/signalk-chart-sources.git
cd signalk-chart-sources
npm ci
npm run verify
```

The development gate follows the same practical toolchain used by Binnacle: Biome formatting and
linting, Markdown linting, spelling, Knip dead-code and cycle checks, workflow invariant checks,
strict TypeScript, native tests and coverage, Publint, exact-tarball consumer smoke tests, builds,
and dependency audits. Run `npm run verify:commit` for the fast repository-quality subset.

`npm run test:upstreams` performs live requests to every configured source and selected capabilities.
Run it when catalog or monitor behavior changes. It is scheduled separately and intentionally excluded
from pull-request CI so an upstream outage does not block unrelated development.

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for contributor expectations and
[RELEASING.md](RELEASING.md) for the approval-gated release process.

## Safety and security

Chart data is advisory and must not be the sole means of navigation. See the
[security policy](.github/SECURITY.md) for input-validation, dependency, disclosure, and marine-safety
guidance.

## License

MIT. See [LICENSE](LICENSE). The software is provided "AS IS", without warranty of any kind.
