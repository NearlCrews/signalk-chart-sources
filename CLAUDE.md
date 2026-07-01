# CLAUDE.md

Guidance for Claude Code (and contributors) working in this repository.

## What this is

`signalk-chart-sources` is a small TypeScript library: the single definition of every upstream chart
and raster overlay source used across the author's marine projects. It is data and pure helpers
only: no MapLibre, no Signal K, and no Node or browser APIs. Two consumers read it, the Binnacle
chartplotter webapp (which renders the sources) and the Chart Locker tile cache (which proxies and
caches them), so one list keeps their render config and their proxy allowlist from drifting.

It is a plain npm library, NOT a Signal K plugin: there is no plugin lifecycle, no schema, and no App
Store listing. It is a transitive dependency of `signalk-chart-locker` and `signalk-binnacle`, not
installed directly by users.

## Architecture rules (do not violate)

- One npm package. The chart catalog lives in `src/registry.ts` as `CHART_SOURCES`, the single
  source of truth. Never fork it into a second list.
- Keep it dependency-free and pure. No runtime dependencies, no side effects, no I/O.
- `webMercatorTileBounds`, `tileForLngLat`, and the `ORIGIN` constant in `src/mercator.ts` must stay
  bit-exact with the Rust tilecache container copy (same formula, constant, and IEEE-754), so the
  proxied and the direct tile requests produce the same cache key. Do not rewrite the math in a way
  that changes output, even an algebraically-equal rewrite.
- Upstream identifiers are load-bearing. The WMS LAYERS and STYLES lists, layer names, upstream URLs,
  and attribution strings match real services; do not reformat or correct them without verifying
  against the upstream. Geographic bounds come from the service GetCapabilities.

## Layout

- `src/registry.ts`: the `CHART_SOURCES` catalog. `src/types.ts`: `ChartSource` and the
  `UpstreamTemplate` union. `src/mercator.ts`: the Web Mercator tile math. `src/expand.ts`: the
  upstream URL builder and the proxy tile template. `src/estimate.ts`: the byte estimate.
  `src/index.ts`: the barrel of public exports. `test/`: node --test suites, one per module.

## Build and test

- `npm run build` (tsc to `dist/`), `npm run typecheck`, and `npm test` (node --test via tsx). There
  is no lint step. CI runs build, typecheck, and test on Node 20 and 22.
- Conventions: a bbox tuple is [west, south, east, north] (longitude before latitude); tile
  coordinates are z/x/y with y increasing downward.

## Writing rules

No em dashes, Oxford commas, the word "and" never the ampersand in prose, "chartplotter" one word,
and American English.
