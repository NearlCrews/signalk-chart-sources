# Repository Guide

## Scope

`signalk-chart-sources` is a dependency-free TypeScript library shared by the Binnacle chartplotter
and the Chart Locker tile cache. It owns the chart-source catalog, upstream URL expansion, Web
Mercator tile math, and conservative download estimates. It is not a Signal K plugin.

## Architecture

- Keep `CHART_SOURCES` in `src/registry.ts` as the only catalog.
- Keep runtime code pure, dependency-free, and usable in Node.js and browsers.
- Keep the `ORIGIN` constant and `webMercatorTileBounds` bit-exact with the Rust tile-cache
  container copy. `tileForLngLat` shares the container's formula but not its floating-point steps,
  so the two can disagree by one tile for a point exactly on a tile boundary. Change both
  implementations together.
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
- `src/mercator.ts`: tile math, coverage tests, counting, bounded enumeration, and lazy iteration.
- `src/expand.ts`: upstream URL expansion, tile templates, and proxy templates.
- `src/request.ts`: the shared WMS and ArcGIS request builder and token substitution, which
  validation and expansion both use.
- `src/estimate.ts`: conservative planning estimates.
- `scripts/check-upstreams.ts`: scheduled live source and capability checks.
- `scripts/package-smoke.mjs`: packed-tarball verification.
- `scripts/audit-policy.mjs`: the reviewed development-only advisories the full audit accepts.
- `scripts/check-workflows.mjs`: workflow permission, pinning, and publication invariants.
- `scripts/records.mjs`: the plain-object guard the maintenance scripts share.

## Verification

Run all of these before handing off a change:

```bash
npm run verify:commit
npm run typecheck
npm run test:coverage
npm run test:package
npm run audit:full
npm run audit:runtime
git diff --check
```

`npm run verify` runs all of the above except `git diff --check`. `verify:commit` covers the
formatting, linting, workflow-invariant, spelling, and dead-code checks that CI enforces separately
from the build. `test:coverage` runs the whole suite under the coverage thresholds, so `npm test` is
only a faster local loop. `test:package` builds, packs, and smoke-tests the exact tarball.

`audit:full` accepts only the advisories listed in `scripts/audit-policy.mjs` and fails on anything
else, including an accepted advisory that is no longer reported. Never lower the audit level or run
`npm audit fix --force` to get past it. `audit:runtime` must stay clean: the package has no runtime
dependencies.

When a workflow changes, run actionlint with shellcheck on the path, and zizmor, locally (for
example through `uvx`); the workflow-security workflow runs both on every workflow change.

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

## Shared skills

Domain expertise for this repository lives in the shared skills installed for both Codex and Claude
Code from `~/src/nearlcrews-agent-toolkit` (Claude Code: `/skill-name`; Codex: `$skill-name`; both
hosts also select them from their descriptions). Load these before working here:

- `signalk-development`: Signal K plugin and webapp lifecycle, server APIs, deltas, route security,
  package metadata, App Store, registry score, plugin CI, and release readiness.
- `standardize-project-toolchain`: toolchain audits, lint, type, test, and CI alignment, and Node or
  TypeScript floor decisions.

To delegate, spawn a general-purpose subagent and tell it which of these to load; there are no
per-host agent definitions.
