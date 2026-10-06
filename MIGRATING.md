# Migration guide

## Migrating from 0.7.x to 0.8.0

Stricter validation of consumer-supplied sources, corrected catalog credits, and two new helpers.
Existing `^0.7.x` dependency ranges do not select 0.8.0, so consumers can migrate and test
deliberately. Consumers that only read the built-in catalog and pass valid inputs need no code
changes, but cached tiles, displayed credits, and some tile counts move.

Validation now rejects input it used to accept:

- A `coverage` region that reaches outside the source's `bounds`. A renderer never requests a tile
  outside the display envelope, so warming one fetched it for nothing. Clip the regions to the
  bounds, or widen the bounds if they were wrong.
- `attribution` markup other than plain text, character entities, and `<a href="https://...">text</a>`
  links, optionally with `target="_blank"`. MapLibre renders attribution as HTML, so any other tag
  was an injection path for an application that accepts third-party definitions. That application
  should still sanitize the text or render it as text; the allowlist is defense in depth.
- `%` in a WMS layer, style, or format value. The server decodes an escape after validation, so
  `a%2Cb` reached it as two layers paired with one style.
- A brace in a WMS layer, style, format, or base value, or in an ArcGIS base. MapLibre replaces its
  own tokens, such as `{ratio}` and `{quadkey}`, anywhere in a tile template, so a renderer using
  `upstreamTileTemplate` would request a different image than a cache using `expandUpstreamUrl`.
- A URL host with a trailing dot or an empty label. `localhost.` resolves to the loopback interface
  but slipped past the loopback check, and `tiles.example.` gave one host a second cache key.
- A URL containing a backslash or an empty authority, such as `https:///tiles.example/{z}/{x}/{y}`.
  The URL parser repairs both, which let a template carry a tile token in its host.
- A source built on prototype properties, getters that change between reads, or `Object.create`.
  `validateChartSource`, the tile helpers, and `estimateBytes` now read a source's own enumerable
  properties once and work on that copy, as `expandUpstreamUrl` already did. Spread such a source
  into a plain object before passing it in.
- `estimateBytes` with an invalid box, zoom range, or averages object, even when the source list is
  empty, and a later invalid source that shares an id with an earlier valid one. Both used to
  return a number.

Error messages escape control, format, and lone-surrogate characters in echoed input, so a test
that matched a raw control character in a message needs the escaped form.

Catalog changes a cache or renderer will see:

- Attributions now follow what each upstream asks for: the full GEBCO 2026 acknowledgement with its
  DOI, the EMODnet DTM 2024 release, the IHO sea areas' CC BY-NC-SA 4.0 license, UNESCO as creator
  of the World Heritage marine sites, the GFS NSST analysis behind the sea surface temperature
  layer, the OpenFreeMap credit for both basemaps, and the OpenStreetMap credit for seamarks. An
  application keeping its own copy of any of these credits should update it.
- `traffic-vessel-density` requests the annual-average layer instead of the monthly one, which,
  requested without a time, showed a single month. Its title is now "Vessel density (annual
  average)". Cached tiles for it are stale.
- BlueTopo `bounds` move outward to `[-138.1, 16.785, -64.197, 59.551]`, recovering a strip along the
  west edge.
- The EMODnet quality and contour facets carry their own coverage, clipped to their bounds, and the
  NOAA ENC Weddell Sea region stops at the service's southern edge. Over the whole world at zooms 0
  to 12, each EMODnet facet falls from 2,245,846 to 2,191,191 tiles, and each NOAA ENC source from
  2,267,591 to 2,267,078.
- `tileForLngLat` converts degrees to radians the way the Rust tile cache does, so a point within a
  few units in the last place of a tile boundary may land one tile over. Counts can shift by the odd
  boundary tile, and agreement with the Rust enumeration improves.

The package no longer has a `prepare` script, so installing it from a Git URL no longer builds it.
Registry installs are unaffected.

`coversBbox`, `coversPoint`, and `upstreamTileTemplate` are new and additive. A consumer that tests
coverage with `tileCountInBbox(...) > 0`, or with a tiny box around a point, can switch to
`coversBbox`, or `coversPoint` with the same zoom range, for the same answer at a fraction of the
cost. Without a zoom range `coversPoint` ignores zoom, so a coarse source such as GEBCO would count
as covering a harbor-scale request. A renderer that builds
its own WMS or ArcGIS tile template can switch to `upstreamTileTemplate`, which honors the source's
tile size, format, and transparency instead of assuming 256 pixel transparent PNG.

## Migrating from 0.6.x to 0.7.0

Twenty new sources, an optional `maxAgeSeconds` field, and stricter host validation. Existing
`^0.6.x` dependency ranges do not select 0.7.0, so consumers can migrate and test deliberately.
Consumers that only read the built-in catalog and pass valid inputs need no code changes, but three
behaviors move.

- Time-dynamic sources exist for the first time, and a cache must honor them. A source carrying
  `maxAgeSeconds` is stale after that many seconds and must not be pre-warmed: warming a weather
  radar fills a cache with frames that are wrong before anyone reads them. A consumer that stores
  tiles has to read the field before it lists any of the `weather-*` or `ocean-*` sources. A
  consumer that only renders can ignore it.
- Consumer-supplied source URLs may no longer carry a port, an IP address literal, or a loopback
  name, in any URL field rather than only in a style `allowedHosts` entry. A definition pointing at
  `https://host:8443/...`, `https://127.0.0.1/...`, or `https://localhost/...` now throws. This is
  the definition-time half of an SSRF policy; a server proxying these must still check the address a
  hostname resolves to, which is the only place a rebind can be caught.
- `depth-emodnet`, its two facets, and `mpa-noaa` now carry derived `coverage` regions, and their
  `bounds` changed to the envelope of those regions. Tile counts and estimates for them change:
  `mpa-noaa` drops about 42 percent while gaining Guam, the Northern Marianas, American Samoa, Wake,
  and the Pacific Remote Islands, which its old box excluded outright. `mpa-emodnet` and
  `mpa-natura2000` also pick up their own advertised envelopes instead of sharing the bathymetry's.
- `estimateBytes` accepts whole `ChartSource` values alongside catalog ids, so a consumer can price a
  source it defined itself. Passing ids keeps working unchanged.
- An `xyz` upstream may carry `tileJsonUrl`. It is additive and optional; a consumer that renders
  tiles can ignore it, and one that wants a MapLibre `url:` source can use it instead of `tiles:`.
- The Seascape attribution is now the short form the service publishes today. A consumer displaying
  its own copy of the long form is showing text upstream no longer serves.
- `expandUpstreamUrl` strips trailing slashes from a WMS `base`, matching what it already did for
  ArcGIS. A cache keyed on the exact request URL sees new keys for any WMS source whose base was
  written with a trailing slash.

## Migrating from 0.5.x to 0.6.0

Version 0.6.0 is a breaking pre-1.0 release. Existing `^0.5.x` dependency ranges do not select it,
so consumers can migrate and test deliberately. These changes alter accepted input, the moment an
error surfaces, or the public type surface. Consumers that only read the built-in catalog and pass
valid inputs need no code changes.

- A bounding box whose west equals its east is now rejected as degenerate. It previously fell into
  the antimeridian wrap and silently expanded to worldwide coverage, so any caller that relied on
  that accidental behavior now receives a `RangeError` instead of a global result.
- `iterateTilesInBbox` validates its inputs and the `maxTiles` total when it is called rather than
  when the returned generator is first advanced. Code that builds an iterator inside a `try` block
  and advances it outside must move the call inside the block.
- Consumer-supplied WMS sources must list one `STYLES` entry per `LAYERS` entry, or leave `STYLES`
  empty, and `LAYERS` may not contain an empty entry. A mismatched pair previously validated and
  produced a request no compliant server answers.
- Source text and URL fields reject more characters: `;` and `=` in WMS layer, style, and format
  values, backslashes in `proxyTileTemplate` plugin bases, C1 controls in source text, and invisible
  characters such as zero-width spaces and bidirectional marks in URLs.
- `estimateBytes` reads `perSourceAvgBytes` by own property only. An average reaching it through the
  prototype chain is now ignored rather than used.
- `tileForLngLat` returns a readonly `{ x, y }`. Code that mutated the returned object must copy it
  first.
- The `Bbox` type alias is removed. Import `LngLatBbox` instead, which names the units.
- The `DEFAULT_TILE_BYTES` export is removed. `estimateBytes` could never reach it, because
  `DEFAULT_TILE_BYTES_BY_MODE` covers every upstream mode. Use that table, or the mode entry you
  want, in its place.
- The WMS and ArcGIS `BBOX` parameter is written in plain decimal. Any cache keyed on the exact
  request URL will see new keys for the tiles whose edges fall on the projection origin.

## Migrating from 0.4.x to 0.5.0

Version 0.5.0 is a breaking pre-1.0 release. Existing `^0.4.x` dependency ranges do not select it,
so consumers can migrate and test deliberately.

- The NOAA ENC sources now carry disjoint `coverage` regions derived from the NOAA ENC product
  catalog. `tileCountInBbox`, `tilesInBbox`, `iterateTilesInBbox`, and `estimateBytes` for
  `depth-noaa-enc` and `depth-noaa-enc-quality` return far smaller totals than the previous
  global-envelope behavior, and regions without any ENC chart cell count zero tiles. `bounds` still
  carries the service display envelope. Re-verify Chart Locker cache-warming budgets and Binnacle
  regions-panel expectations against the new numbers.
- `estimateBytes` counts a duplicated source id once, so repeated ids no longer inflate totals.
- Validation is stricter for consumer-constructed sources and plugin bases:
  - Upstream URLs reject a bare trailing `?` or `#`.
  - XYZ and WMTS templates reject tokens in the host and require each of `{z}`, `{x}`, and `{y}`
    exactly once.
  - WMS layer, style, and format values reject `+`, and style allowed hosts reject ports.
  - Optional text such as attribution accepts the empty string but rejects non-empty
    whitespace-only values.
  - `proxyTileTemplate` plugin bases reject whitespace, control characters, `?`, `#`, and braces.

Consumers that only read the built-in catalog and call tile helpers with valid inputs need no code
changes beyond re-checking NOAA ENC counts and estimates.

## Migrating from 0.3.x to 0.4.0

Version 0.4.0 is a breaking pre-1.0 release. Existing `^0.3.x` dependency ranges do not select it,
so consumers can migrate and test deliberately. Consumers that construct source objects outside the
built-in catalog must review these tightened fail-closed requirements:

- `validateChartSource` now accepts `unknown`, checks the complete runtime structure, and narrows a
  successful value to `ChartSource`. Missing, sparse, incorrectly typed, and unknown mode values are
  rejected before any nested field is used.
- Source text, URLs, WMS values, coverage arrays, and style-host arrays have bounded sizes aligned
  with the Chart Locker container boundary.
- HTTPS URLs reject credentials and fragments. WMS and ArcGIS base URLs also reject query strings.
  WMS version must be `1.3.0`, and layer, style, and format values reject `&`, `?`, and `#`.
- XYZ and WMTS templates accept only `{z}`, `{x}`, and `{y}` placeholders. Style hosts must be valid,
  unique case-insensitively, and include the style URL host.
- `[180, south, -180, north]` is rejected as a zero-longitude-span bbox in both TypeScript and the
  Rust tile-cache mirror.
- Bbox tile edges remain inclusive for conservative warming. A region ending exactly on a tile
  boundary can include the adjacent boundary tile.

The Rust mirror in Chart Locker must be updated with the package so direct container configuration
cannot accept a source that the TypeScript boundary rejects.

## Migrating from 0.2.x to 0.3.x

Version 0.3.0 is a breaking pre-1.0 release. Existing `^0.2.x` dependency ranges do not select it,
so consumers can migrate and test deliberately.

### All consumers

1. Upgrade the runtime and development environment to Node.js 22 or newer.
2. Change the dependency to `^0.3.0`, refresh the lockfile, and run the consumer's complete checks.
3. Treat `CHART_SOURCES`, catalog entries, nested upstream values, bbox tuples, zoom tuples, and tile
   coordinates as readonly. Clone values only where a mutable third-party API requires it.
4. Catch `TypeError` and `RangeError` at request or UI boundaries. Invalid source definitions,
   coordinates, zooms, source ids, estimate averages, and enumeration limits now fail closed.
5. Use `tileCountInBbox` for count-only work. Use `iterateTilesInBbox` for streaming, and set an
   explicit reviewed `maxTiles` when one million tiles is not the right limit.
6. Accept `west > east` as an antimeridian-crossing bbox. Do not reject it solely because longitude
   ordering is reversed.
7. Treat `estimateBytes` as planning data. Enforce actual tile-count and transferred-byte limits in
   the server that performs downloads.
8. Review NOAA ENC behavior because its display bounds now use the service-level capabilities
   envelope and may include transparent tiles outside actual chart coverage.

### Chart Locker

Chart Locker requires code and metadata changes before upgrading:

- Raise its Node.js engine floor from 20 to 22.
- Make the config payload source collection readonly, or clone `CHART_SOURCES` at the serialization
  boundary. JSON serialization itself does not require mutable data.
- Update bbox request validation to accept antimeridian-crossing regions while retaining latitude,
  longitude, finiteness, and non-zero-area checks.
- Validate request source ids against the catalog before estimation, and translate estimate
  `TypeError` and `RangeError` failures into a bounded client error instead of an unhandled route
  failure.
- Keep hard enforcement of actual cache budgets after the planning estimate.
- Type-check the plugin, container payload, route tests, and packed Signal K plugin before changing
  its dependency range.

### Binnacle

Binnacle already requires Node.js 22, but its estimate integration requires review:

- Replace text and tests that describe an estimate as a byte ceiling. Compressed tile averages and
  fallbacks are planning values, not mathematical upper bounds.
- Test the source-specific and mode-specific fallbacks instead of assuming every uncached source uses
  `DEFAULT_TILE_BYTES`.
- Catch estimate validation errors at the regions-panel boundary so stale or malformed cache
  statistics produce a useful state instead of breaking rendering.
- Update mutable annotations only where readonly catalog values are passed directly. Arrays returned
  by `filter` remain new mutable arrays whose elements are readonly.
- Add region-selection coverage for antimeridian boxes and the revised NOAA ENC envelope.
- Type-check and build the webapp before changing its dependency range.

### Release ordering

Publish the 0.3.x package first, then update each consumer in its own reviewed change. Do not widen
an existing 0.2.x range. Verify Binnacle and Chart Locker independently against the published
package and commit their refreshed lockfiles.
