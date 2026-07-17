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
- `coverage`: optional disjoint warming and estimate regions. When present, tile helpers use it
  instead of `bounds`.
- `fallbackTileBytes`: a conservative first-download estimate used until a measured average exists.
- `vectorMaxzoom`: the native vector-data maximum, below the visual overzoom ceiling when needed.

Catalog values are frozen at runtime and readonly in TypeScript. Consumers must derive local display
metadata instead of mutating catalog entries.

### Coordinate types

- `LngLatBbox`: `[west, south, east, north]` in degrees.
- `MercatorBbox`: `[minX, minY, maxX, maxY]` in EPSG:3857 meters.
- `Bbox`: compatibility alias for `LngLatBbox`; new code should use the unit-specific name.
- `ZoomRange`: inclusive `[minzoom, maxzoom]` integers.
- `ZXY`: readonly `{ z, x, y }` tile coordinate.
- `TileEnumerationOptions`: currently `{ maxTiles?: number }`.

A longitude-latitude box crosses the antimeridian when `west > east`. Degenerate boxes, invalid
latitudes or longitudes, and non-finite values throw `RangeError`. `[180, south, -180, north]` has a
zero longitude span and is invalid even though its west value is greater than its east value.

### Tile math

- `webMercatorTileBounds(z, x, y)`: return the EPSG:3857 bounds of one valid XYZ tile.
- `tileForLngLat(lng, lat, z)`: return the integer tile containing a finite point. Latitude clamps to
  `MAX_MERCATOR_LAT`, and finite longitudes outside `[-180, 180]` clamp to an edge tile.
- `tileCountInBbox(source, bbox, zoomRange)`: count distinct tiles without allocating the tile list.
- `tilesInBbox(source, bbox, zoomRange, options)`: return distinct tiles as an array. The default
  `maxTiles` is `DEFAULT_MAX_ENUMERATED_TILES`, currently 1,000,000.
- `iterateTilesInBbox(source, bbox, zoomRange, options)`: lazily yield the same distinct tiles. It
  still validates the total against `maxTiles` before yielding.
- `MAX_MERCATOR_LAT`: the Web Mercator latitude limit, approximately 85.0511 degrees.
- `MAX_TILE_ZOOM`: the highest accepted zoom, currently 30.
- `DEFAULT_MAX_ENUMERATED_TILES`: the defensive default enumeration limit.

Tile helpers validate source metadata, coordinates, zooms, zoom ordering, and safe-integer counts.
Invalid inputs throw instead of returning partial or ambiguous results. Geographic bbox edges are
inclusive for conservative warming, so a box ending exactly on a tile boundary includes the tile on
both sides of that boundary.

### URL construction

- `expandUpstreamUrl(source, z, x, y)`: validate the source and coordinate, substitute XYZ or WMTS
  tokens, construct WMS or ArcGIS parameters, or return a style URL.
- `proxyTileTemplate(pluginBase, sourceId)`: normalize a trailing slash on the plugin base, validate
  the path-safe source id, and return the Chart Locker tile template.

`expandUpstreamUrl` only constructs a string. The consuming application performs the network request.
Source validation requires bounded HTTPS URLs without credentials or fragments. XYZ and WMTS
templates may contain only `{z}`, `{x}`, and `{y}` tokens. WMS and ArcGIS base URLs may not contain
query parameters, WMS version must be `1.3.0`, and WMS layer, style, and format values may not inject
query delimiters. Style hosts are validated, deduplicated case-insensitively, and must authorize the
style URL itself.

### Download planning

- `estimateBytes(sourceIds, bbox, zoomRange, perSourceAvgBytes)`: multiply distinct tile counts by a
  positive measured average or a conservative first-download fallback.
- `DEFAULT_TILE_BYTES`: generic fallback, currently 512,000 bytes.
- `DEFAULT_TILE_BYTES_BY_MODE`: fallbacks for XYZ, WMTS, WMS, ArcGIS, and style modes.

Unknown source ids, invalid measured averages, and totals beyond `Number.MAX_SAFE_INTEGER` throw.
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

The catalog currently holds 16 sources:

| Category | Stable ids | Upstream modes |
| --- | --- | --- |
| Bathymetry | `depth-gebco`, `depth-emodnet`, `depth-emodnet-quality`, `depth-bluetopo`, `depth-bluetopo-uncertainty`, `depth-noaa-enc`, `depth-noaa-enc-quality`, `seascape-dem`, `seascape-vector` | WMS, WMTS, XYZ |
| Seamarks | `seamark` | XYZ |
| Maritime boundaries | `bound-eez`, `bound-12nm` | WMS |
| Marine protected areas | `mpa-emodnet`, `mpa-natura2000`, `mpa-noaa` | WMS, ArcGIS |
| Basemap | `basemap` | Style |

Source ids, upstream layer names, styles, URLs, dimensions, bounds, and attribution are load-bearing
configuration. The scheduled upstream monitor samples every source and compares selected capability
metadata. It parses configured WMS layers, styles, formats, CRS support, WMTS matrix definitions, and
the complete transitive style and TileJSON host graph. Verify the upstream service before changing
catalog data.

## Migrating to 0.3.0

The unreleased changes include intentional compatibility changes:

- The Node.js floor moves from 20 to 22.
- Catalog entries, nested upstream objects, arrays, and shared tuple types become readonly.
- Invalid coordinates, zooms, boxes, source definitions, estimate statistics, and unknown estimate
  source ids throw instead of being clamped, ignored, or converted to empty results.
- `tilesInBbox` rejects enumeration above its default limit. Use `tileCountInBbox`, pass an explicit
  reviewed `maxTiles`, or use `iterateTilesInBbox` for bounded streaming.
- Antimeridian-crossing boxes now split, merge, and deduplicate correctly.
- NOAA ENC display bounds now follow the service-level WMS capabilities envelope.
- First-download fallbacks are conservative and source-aware rather than a single 25,000-byte value.

Consumers should type-check against the release before upgrading and review every call that accepts
untrusted geometry, statistics, or source ids. See [MIGRATING.md](MIGRATING.md) for an upgrade
checklist and the known Binnacle and Chart Locker changes.

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
