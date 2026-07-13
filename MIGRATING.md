# Migrating to 0.3.0

Version 0.3.0 is a breaking pre-1.0 release. Existing `^0.2.x` dependency ranges do not select it,
so consumers can migrate and test deliberately.

## All consumers

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

## Chart Locker

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

## Binnacle

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

## Release ordering

Publish 0.3.0 first, then update each consumer in its own reviewed change. Do not widen an existing
0.2.x range. Verify Binnacle and Chart Locker independently against the published package and commit
their refreshed lockfiles.
