# Repository Guide

## Scope

`signalk-chart-sources` is a dependency-free TypeScript library shared by the Binnacle chartplotter
and the Chart Locker tile cache. It owns the chart-source catalog, upstream URL expansion, Web
Mercator tile math, and conservative download estimates. It is not a Signal K plugin.

## Architecture

- Keep `CHART_SOURCES` in `src/registry.ts` as the only catalog.
- Keep runtime code pure, dependency-free, and usable in Node.js and browsers.
- Keep `webMercatorTileBounds`, `tileForLngLat`, and the `ORIGIN` constant bit-exact with the Rust
  tile-cache container copy. Change both implementations together.
- Treat source ids, layer lists, style names, URLs, bounds, and attribution as verified upstream
  data. Check service capabilities before changing them.
- Preserve runtime immutability and fail-closed input validation.
- Use `coverage` for disjoint warming coverage. Keep `bounds` as the display envelope.
- Count before enumeration, retain a defensive `maxTiles`, and reject unsafe integer totals.
- Treat `estimateBytes` as planning data only. Actual tile counts and transferred bytes require
  enforcement by the consuming server.
- Do not perform live upstream checks in pull-request CI. The scheduled upstream monitor owns them.

## Layout

- `src/registry.ts`: immutable source catalog and id lookup.
- `src/types.ts`: public source, bbox, zoom, and enumeration types.
- `src/validate.ts`: public input and source validation.
- `src/mercator.ts`: tile math, counting, bounded enumeration, and lazy iteration.
- `src/expand.ts`: upstream and proxy URL construction.
- `src/estimate.ts`: conservative planning estimates.
- `scripts/check-upstreams.ts`: scheduled live source and capability checks.
- `scripts/package-smoke.mjs`: packed-tarball verification.

## Verification

Run all of these before handing off a change:

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:package
npm audit
git diff --check
```

Run `npm run test:upstreams` when catalog data, source validation, or monitoring changes. It performs
live network requests and is intentionally separate from normal pull-request checks.

## Documentation

- Update README API and migration sections whenever a public export or behavior changes.
- Add user-visible changes to the Unreleased changelog section without rewriting historical releases.
- Update `RELEASING.md` when workflow triggers, permissions, environments, or npm authentication
  change.
- Keep issue and pull-request templates aligned with supported Node.js versions and verification.

## Releases

- Follow `RELEASING.md`.
- Never create a version tag, publish a GitHub release, or publish to npm without explicit final
  maintainer approval.
- Treat the npm trusted-publisher relationship and protected `npm` environment as release
  prerequisites, not workflow assumptions.

## Writing

- Use American English and Oxford commas.
- Do not use em dashes in committed text.
- Use `and`, not an ampersand, in prose unless syntax or a proper noun requires the ampersand.
- Spell `chartplotter` as one word.
