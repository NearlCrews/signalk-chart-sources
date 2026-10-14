# signalk-chart-sources

[![npm version](https://img.shields.io/npm/v/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![npm downloads](https://img.shields.io/npm/dm/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![CI](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/NearlCrews/signalk-chart-sources/blob/main/LICENSE)
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
  invalid runtime shape, id, text field, tile size, zoom range, URL, bounds, coverage, fallback
  size, TTL, group descriptor, or mode-specific requirement. Its assertion signature accepts
  `unknown` and narrows successful values to `ChartSource`.
- `ChartSource`, `UpstreamTemplate`, and `ChartGroup`: public catalog types.

Each `ChartSource` may contain:

- `bounds`: one geographic display envelope, omitted for worldwide sources. Validation and the tile
  helpers accept a box that crosses the antimeridian, but MapLibre's source `bounds` treats a west
  edge east of the east edge as covering no tile at all, so it hides the layer everywhere. No
  catalog source crosses. A renderer handed a consumer-supplied crossing envelope must widen it, for
  example to `[-180, south, 180, north]`, before passing it to MapLibre.
- `coverage`: optional warming and estimate regions. When present, tile helpers use it instead of
  `bounds`, and every region must lie within `bounds` when a source carries both, because a renderer
  never requests a tile outside the display envelope and warming one would fetch it for nothing.
  Regions need not be disjoint, because tile helpers deduplicate overlaps. The NOAA ENC
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
metadata instead of mutating catalog entries. Catalog sources are validated once, when the catalog
loads, and the helpers below do not check them again.

`attribution` is HTML, because MapLibre renders it as markup and several upstreams ask for a linked
credit. Validation accepts plain text, character entities, and `<a href="https://...">` links,
optionally with `target="_blank"`, and rejects any other markup. That allowlist is defense in depth,
not a sanitizer: an application that accepts source definitions from anywhere other than this
catalog should still sanitize the attribution or render it as text.

### Coordinate types

- `LngLatBbox`: `[west, south, east, north]` in degrees.
- `MercatorBbox`: `[minX, minY, maxX, maxY]` in EPSG:3857 meters.
- `ZoomRange`: inclusive `[minzoom, maxzoom]` integers.
- `ZXY`: readonly `{ z, x, y }` tile coordinate.
- `TileEnumerationOptions`: currently `{ maxTiles?: number }`. `tilesInBbox` and `iterateTilesInBbox`
  accept it optionally, but when given it must be an object, and only its own `maxTiles` is read, so
  a value inherited through the prototype chain cannot lift the default limit.

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
- `coversBbox(source, bbox, zoomRange)`: report whether the source covers any tile of the box within
  the zoom range. It gives the same answer as `tileCountInBbox(...) > 0` without counting, and never
  raises the unsafe-total error a huge box at a deep zoom raises there.
- `coversPoint(source, lng, lat, zoomRange?)`: report whether a point lies inside the source's
  coverage regions, its bounds, or anywhere for a worldwide source. Edges are inclusive and regions
  crossing the antimeridian are split there. A finite point beyond `[-180, 180]` or past
  `MAX_MERCATOR_LAT` returns `false`, and a non-finite coordinate throws `RangeError`. Without
  `zoomRange` it ignores zoom. With one, it also requires the source to serve a zoom in that range,
  as `coversBbox` does, so a coarse source does not count as covering a harbor-scale request.
- `tilesInBbox(source, bbox, zoomRange, options)`: return distinct tiles as an array. The default
  `maxTiles` is `DEFAULT_MAX_ENUMERATED_TILES`, currently 1,000,000.
- `iterateTilesInBbox(source, bbox, zoomRange, options)`: lazily yield the same distinct tiles.
  Inputs and the total are checked against `maxTiles` when the call is made, not when the generator
  is first advanced, so a rejected request fails closed even if the caller never iterates.
- `MAX_MERCATOR_LAT`: the Web Mercator latitude limit, approximately 85.0511 degrees.
- `MAX_TILE_ZOOM`: the highest accepted zoom, currently 30.
- `DEFAULT_MAX_ENUMERATED_TILES`: the defensive default enumeration limit.

Tile helpers validate source metadata, coordinates, zooms, zoom ordering, and safe-integer counts.
Invalid inputs throw instead of returning partial or ambiguous results. A malformed source object,
text field, URL field, or enumeration options value throws `TypeError`. A box, zoom range,
coordinate, zoom, count, `maxTiles`, or numeric source field throws `RangeError`, whether the value
is out of range or of the wrong type. A source definition can therefore raise either, so catch both
at request and UI boundaries.

`validateChartSource` and every helper read a source's own enumerable properties, once, and work on
that copy. A getter therefore cannot hand validation one value and the tile math another, a source
defined through prototype properties or `Object.create` throws, and a polluted `Object.prototype`
cannot add coverage or a time-to-live to any source, catalog sources included. List fields such as
`bounds`, `coverage`, and `allowedHosts` are copied entry by entry, own entries only, never through
the list's own constructor, so an entry inherited from a polluted `Array.prototype` stays a hole and
fails the dense check. The tile helpers and `estimateBytes` read a caller's box and zoom range the
same way, each entry once, into a private copy, so an index getter or a custom iterator cannot pass
validation with one value and reach the tile math with another.

Because `validateChartSource` asserts the values it read during the call, a source built on accessors
can read differently afterwards. Validate plain data, such as parsed JSON, before relying on the type
it narrows to. The helpers never rely on that narrowing, because each validates its own copy.

`webMercatorTileBounds` is bit-exact with the Rust tile cache. `tileForLngLat` shares the Rust
formula and its operation order, but the two runtimes use different math libraries, so a point within
a few units in the last place of a tile boundary can land in the neighboring tile. A count here and an
enumeration there can therefore differ by the odd boundary tile, which is why the consuming server
enforces its own tile limits.

Geographic bbox edges are inclusive for conservative warming, and that inclusivity is directional
because the tile index always floors. A box whose east or south edge lands exactly on a tile boundary
also covers the tile beyond that edge; a box whose west or north edge lands on a boundary does not
reach back across it.

### URL construction

- `expandUpstreamUrl(source, z, x, y)`: validate the source and coordinate, substitute XYZ or WMTS
  tokens, construct WMS or ArcGIS parameters, or return a style URL.
- `upstreamTileTemplate(source)`: return the tile URL template a renderer requests directly: the XYZ
  or WMTS template as written, or the WMS `GetMap` or ArcGIS export URL with MapLibre's
  `{bbox-epsg-3857}` token in place of the box. The same code builds `expandUpstreamUrl`'s request,
  so filling the token reproduces it, and a direct renderer and a proxying cache ask the upstream for
  the same image. A `style` source throws `TypeError`, because it has no tile template.
- `proxyTileTemplate(pluginBase, sourceId)`: normalize trailing slashes on the plugin base, validate
  the base and the path-safe source id, and return the Chart Locker tile template.

`expandUpstreamUrl` only constructs a string. The consuming application performs the network request.
Source validation requires bounded HTTPS URLs that name their host directly after `https://`, without
credentials, backslashes, or fragments, including a bare trailing `#`. The URL parser silently
repairs `https:///host` and `https:\\host`, so accepting them would give one upstream two spellings.
URL fields, style hosts, WMS values, and plugin bases also reject invisible characters: the whole
Unicode default-ignorable set, including zero-width and bidirectional marks, variation selectors, and
the Hangul fillers. IDNA discards them, so a host carrying one reads as a different host than the one
the request reaches. XYZ and WMTS templates may contain only `{z}`,
`{x}`, and `{y}` tokens, each exactly once, the host may not contain tokens or change with the
requested tile, and no other brace may survive expansion. WMS and ArcGIS base URLs may not contain
query parameters or a bare trailing `?`, and WMS version must be `1.3.0`. WMS layer, style, and
format values may not contain `%`, because the server decodes an escape after validation has passed,
and may not inject query delimiters, `+`, `;`, or `=`. Neither those values nor a WMS or ArcGIS base
may contain a brace, because MapLibre fills its own tokens anywhere in a template and a direct
request would then differ from the proxied one. WMS `LAYERS` may not contain an empty entry,
and `STYLES` must be either empty or name one style per requested layer, as WMS 1.3.0 pairs the two
lists by position. Optional text fields accept the empty string but reject non-empty whitespace-only
values. Style hosts must not repeat, compared case-insensitively, and must authorize the style URL
itself. Plugin bases reject whitespace, control and invisible characters, `?`, `#`, braces, and
backslashes.

Every URL field rejects ports, IP address literals, loopback names, and hosts with an empty label or
a trailing dot. A chart source names a public service, so `https://host:8443/wms`,
`https://127.0.0.1/wms`, `https://[::1]/wms`, `https://localhost/wms`, and `https://localhost./wms`
all throw, as do the octal and integer spellings of an address that the URL parser rewrites to a
dotted quad. A trailing dot names the same DNS host as the bare name, so rejecting it closes the
loopback spelling and keeps every host to one cache key. Address literals are rejected wholesale
rather than range by range, which keeps the private-range table in the one place that can act on it.

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
  registering it. Every supplied source is validated in full before deduplication, so an invalid
  entry throws even when an earlier entry has the same id. Entries resolving to the same id are
  counted once, the first occurrence winning.
- `DEFAULT_TILE_BYTES_BY_MODE`: per-mode fallbacks for XYZ, WMTS, WMS, ArcGIS, and style. A source
  without its own `fallbackTileBytes` falls back to the entry for its mode.

`perSourceAvgBytes` is read by own property only, so an average inherited through the prototype chain
is ignored rather than treated as a measurement. The box, the zoom range, and the averages object are
validated even for an empty source list. Unknown source ids, invalid measured averages, and totals
beyond `Number.MAX_SAFE_INTEGER` throw.
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
metadata. It parses configured WMS layers, styles, formats, CRS support, WMTS matrix definitions,
and the complete transitive style and TileJSON host graph, and it checks the pixel size of PNG and
WebP sample tiles and that each tile arrives as the format its request names. WMS layers inherit
envelopes and styles from their enclosing layers, as WMS 1.3.0 specifies. Catalog bounds must lie
within half a degree of the union of the envelopes the requested layers advertise, and must also
hold all of them, so a layer that grows past its catalog bounds is reported, as is a bounded source
whose layers advertise no envelope at all. Only the edges the monitor lists as deliberately
narrower, such as the EMODnet DTM's sampled extent, are exempt, and a WMTS source's bounds must
match a WMS source checked this way. The monitor compares each TileJSON's tile list, attribution,
and zoom range with the catalog, the GEBCO and EMODnet credits with the release each service serves,
the NOAA ENC layer titles with the layers each facet requests, and the NOAA MPA ArcGIS service's
sub-layers and extent with what the catalog was derived from. Because that export request names no
layers, every NOAA MPA sub-layer must also stay visible by default at every scale. Each WMS service
reports separately, and every redirect hop is checked before it is followed. Only transient failures
are retried: network errors, timeouts, and HTTP 408, 425, 429, 500, 502, 503, and 504, up to twice,
after about 2 and 6 seconds. A network failure is reported with its URL and underlying cause. Verify
the upstream service before changing catalog data.

## Migrating to 0.9.0

The helpers accept less, so a call or a consumer-supplied source that passed under 0.8 may now throw:

- The `options` argument of `tilesInBbox` and `iterateTilesInBbox` must be an object, and only its
  own `maxTiles` counts. Pass `{ maxTiles: 100 }`, not `100`.
- URLs, `allowedHosts` entries, WMS layer, style, and format values, and `proxyTileTemplate` plugin
  bases may not contain any Unicode default-ignorable character, such as a variation selector or a
  Hangul filler.
- A list that relied on its own `Symbol.species`, or on a polluted `Array.prototype` filling a hole,
  no longer passes. Plain arrays and parsed JSON are unaffected.

Error messages quote rejected strings and name rejected objects by type. Catalog credits for the
EMODnet Human Activities, Marine Regions, and OpenSeaMap layers changed, bounds transcribed from an
advertised envelope round outward, `weather-radar-conus` has a new title, and `mpa-noaa` moved in
`CHART_SOURCES`, so displayed credits, the catalog order, and some tile counts move. See the
[migration guide](https://github.com/NearlCrews/signalk-chart-sources/blob/main/MIGRATING.md) for
the details and for every earlier migration.

## Development

```bash
git clone https://github.com/NearlCrews/signalk-chart-sources.git
cd signalk-chart-sources
npm ci
npm run verify
```

Development needs Node.js 22.18 or newer, although the published package supports Node.js 22 or
newer.

The development gate follows the same practical toolchain used by Binnacle: Biome formatting and
linting, Markdown linting, spelling, Knip dead-code and cycle checks, workflow invariant checks,
strict TypeScript, native tests and coverage, Publint, and builds. It also type-checks the packed
tarball's declarations with TypeScript 7 and TypeScript 6 under both NodeNext and Bundler resolution,
and runs a runtime dependency audit plus a full audit that accepts only reviewed development
advisories. Run `npm run verify:commit` for the fast repository-quality subset. CI builds, tests,
and smoke-tests the packed package on Linux, macOS, and Windows, and checks workflow files with
actionlint and zizmor.

`npm run test:upstreams` performs live requests to every configured source and selected capabilities.
Run it when catalog or monitor behavior changes. It is scheduled separately and intentionally excluded
from pull-request CI so an upstream outage does not block unrelated development.

See the
[contributor guide](https://github.com/NearlCrews/signalk-chart-sources/blob/main/.github/CONTRIBUTING.md)
for contributor expectations and the
[release guide](https://github.com/NearlCrews/signalk-chart-sources/blob/main/RELEASING.md) for the
approval-gated release process.

## Safety and security

Chart data is advisory and must not be the sole means of navigation. See the
[security policy](https://github.com/NearlCrews/signalk-chart-sources/blob/main/.github/SECURITY.md)
for input-validation, dependency, disclosure, and marine-safety guidance.

## License

MIT. See the
[license](https://github.com/NearlCrews/signalk-chart-sources/blob/main/LICENSE). The software is provided "AS IS", without warranty of any kind.
