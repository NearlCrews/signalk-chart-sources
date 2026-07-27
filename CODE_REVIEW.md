# Code Review: signalk-chart-sources

Reviewed: 2026-07-27 against `v0.4.0` (commit `261bc3a`) with Unreleased changes staged.
REVIEW.md records the prior v0.4.0 review. This document is an independent follow-up focused on what
remains after that hardening pass.

## 1. Scope and context

### What this package is

ESM-only, zero-runtime-dependency TypeScript library, Node `>=22`. Owns the shared chart-source
catalog, upstream URL expansion, Web Mercator tile math, and conservative download estimates. Not a
Signal K plugin. Consumed by two downstream projects:

- **signalk-binnacle** (Binnacle chartplotter): a MapLibre-based webapp. Imports `CHART_SOURCES` for
  render config and augments it with UI-only metadata by id. Uses `expandUpstreamUrl` for the proxied
  tile path and `estimateBytes` for the regions-panel download estimate.
- **signalk-chart-locker** (Chart Locker tile cache): a Signal K plugin plus a Rust container. Uses
  `CHART_SOURCES` for the proxy allowlist, tile counting for cache warming, and `estimateBytes` for
  server-side budget re-validation. The Rust container carries a bit-exact copy of the Web Mercator
  math.

### Context7 research

- **Signal K server**: Context7 has no tracked documentation for Signal K server. The repo's
  SECURITY.md links to <https://signalk.org/documentation/>, and the package's role in the Signal K
  ecosystem is documented in README and AGENTS.md. No library-doc lookup was possible, so context
  came from the repo itself and its downstream references.
- **MapLibre GL JS** (`/maplibre/maplibre-gl-js`, v5.19.0): queried the style-spec source model.
  MapLibre's `raster` source type uses `tiles`, `tileSize`, `minzoom`, `maxzoom`, and `attribution`,
  and WMS sources are raster sources whose `tiles` URL carries the `{bbox-epsg-3857}` token that
  MapLibre substitutes at render time. This confirms the library's design boundary:
  `expandUpstreamUrl` computes the explicit EPSG:3857 bbox per z/x/y for the tile-cache fetch path
  (Chart Locker warming and proxying), which is distinct from MapLibre's renderer-side token
  substitution. The two paths are complementary, and the library correctly depends on neither
  MapLibre nor a browser runtime.

### Baseline verification

- `npm run typecheck`: green.
- `npm test`: 53 tests, 0 failures.
- `npm outdated`: only `markdownlint-cli2` 0.23.1 has a patch (0.23.2) available. All other
  exact-pinned devDependencies are current.

## 2. Overall assessment

The library is well-engineered and recently hardened. The v0.4.0 release closed the obvious
input-validation, immutability, ReDoS, XML-entity, and CI gaps. The remaining findings are
smaller-scope: one data-quality improvement with real downstream impact, a few defensive-test and
validation refinements, and minor housekeeping. No high-severity issues.

Strengths worth preserving:

- Pure, dependency-free, isomorphic runtime. No MapLibre, Signal K, Node, or browser APIs.
- Bit-exact `ORIGIN` constant and Mercator formulas, documented as needing paired updates with the
  Rust container.
- Fail-closed validation throughout: bounded text, HTTPS-only, no credentials or fragments, no query
  injection, antimeridian-aware bbox, safe-integer count rejection.
- Count-before-enumerate with a defensive `maxTiles` default, plus a lazy iterator.
- Deeply frozen catalog with cycle-safe `deepFreeze`.
- Thorough drift-guard tests on transcribed upstream data.

## 3. Findings

### Medium

**M1. NOAA ENC has no `coverage`, so counts and estimates cover a global envelope.**

- `coverage` (`src/types.ts:63`) is the documented field for disjoint warming regions where one
  rectangle cannot represent useful coverage. AGENTS.md says to use it for disjoint warming and keep
  `bounds` as the display envelope. The field is tested (`test/mercator.test.ts:152-162`) but no
  catalog source uses it.
- `depth-noaa-enc` and `depth-noaa-enc-quality` carry `bounds: [-180, -78.333, 180, 81.6]`
  (`src/registry.ts:26`), and `registry.ts:25-26` explicitly notes actual ENC coverage is sparse
  inside that box. Because `clipBboxes` (`src/mercator.ts:71-83`) falls back to `bounds` when
  `coverage` is absent, `tileCountInBbox` and `estimateBytes` for NOAA ENC return values sized to the
  entire global envelope, not actual chart coverage. Chart Locker warming queues many empty or
  transparent tiles, and the Binnacle panel estimate overstates the download.
- This is the single highest-impact improvement. It is a data change, not a code change, and requires
  upstream verification per AGENTS.md ("Check service capabilities before changing them").

### Low

**L1. No test locks the `fallbackTileBytes` invariant.**

- `estimateBytes` (`src/estimate.ts:46-49`) falls back through `perSourceAvgBytes`, then
  `source.fallbackTileBytes`, then `DEFAULT_TILE_BYTES_BY_MODE[mode]`, then `DEFAULT_TILE_BYTES`.
  REVIEW.md records that the mode and default constants are unreachable today because every catalog
  source carries an explicit `fallbackTileBytes`. That invariant is not asserted in tests, so a future
  source added without `fallbackTileBytes` would silently shift onto the mode defaults.

**L2. `assertBoundedText` permits whitespace-only text when `allowEmpty` is true.**

- `src/validate.ts:54` skips the empty check entirely when `allowEmpty` is true, so `"   "` passes for
  attribution and WMS styles. No catalog source hits this, but the door is open.

**L3. `assertTemplate` does not reject duplicate tokens.**

- `src/validate.ts:147-151` checks each of `{z}`, `{x}`, `{y}` is present and that no unsupported
  token remains, but a template like `https://h/{z}/{x}/{y}/{z}.png` passes. Harmless (produces a
  valid URL), but could mask a typo.

**L4. markdownlint-cli2 patch available.**

- `npm outdated` shows `markdownlint-cli2` 0.23.1 has 0.23.2 available. Bump the exact pin and re-run
  `npm run lint:docs`.

**L5. Upstream monitor failure has no durable notification.**

- `upstream-monitor.yml` runs weekly and fails the workflow on drift. GitHub emails the last committer
  on scheduled-workflow failure, but there is no issue created and no persistent signal. A maintainer
  who misses the email would not notice drift until the next weekly run.

### Nits

**N1. `SEASCAPE_ATTR` is one very long line.**

- `src/registry.ts:40-41` is a single enormous string literal, hard to read and diff. It is verbatim
  from upstream and the comment documents provenance. Splitting into an array joined by `' | '` would
  improve readability without changing the value, but reduces verbatim-provenance clarity. Judgment
  call.

**N2. REVIEW.md is an undated historical artifact in the repo root.**

- REVIEW.md is not shipped (not in `files`), so it does not affect consumers. Adding a dated header
  noting it is the v0.4.0 review record would prevent future confusion about whether it is current.

## 4. Improvement plan

Ordered by impact. Each item lists what, why, where, how, and verification.

### Plan item 1: Add `coverage` to NOAA ENC sources (M1)

- **What**: add disjoint `coverage` boxes to `depth-noaa-enc` and `depth-noaa-enc-quality` reflecting
  actual ENC chart coverage regions.
- **Why**: makes `tileCountInBbox` and `estimateBytes` reflect real chart coverage instead of the
  global service envelope. Directly improves Chart Locker cache-warming efficiency and Binnacle panel
  estimate accuracy for the sparsest source in the catalog.
- **Where**: `src/registry.ts:115-124` (both NOAA ENC entries).
- **How**:
  1. Verify actual ENC coverage against the NOAA MCS capabilities or the NOAA chart index. AGENTS.md
     requires checking service capabilities before changing catalog data.
  2. Encode the verified regions as `coverage: [[west, south, east, north], ...]` on both NOAA ENC
     sources. Keep `bounds` as the display envelope.
  3. Add a registry drift-guard test pinning the coverage box count and representative coordinates,
     mirroring the existing BlueTopo bounds drift guard (`test/registry.test.ts:133-138`).
  4. Run `npm run test:upstreams` to confirm the live service still serves representative tiles inside
     the new coverage regions.
- **Verification**: `npm test`, `npm run test:upstreams`, and a manual check that `tileCountInBbox`
  for a non-US region drops to near zero.

### Plan item 2: Add a `fallbackTileBytes` invariant test (L1)

- **What**: assert every `CHART_SOURCES` entry has a positive safe-integer `fallbackTileBytes`.
- **Why**: locks the by-design unreachability of the mode and default fallback constants in
  `estimateBytes`, so a future source cannot silently regress onto mode defaults.
- **Where**: `test/registry.test.ts`.
- **How**: add a test iterating `CHART_SOURCES` and asserting
  `Number.isSafeInteger(s.fallbackTileBytes) && s.fallbackTileBytes > 0`.
- **Verification**: `npm test`.

### Plan item 3: Tighten `assertBoundedText` whitespace handling (L2)

- **What**: when `allowEmpty` is true, accept the empty string but reject non-empty whitespace-only
  values.
- **Why**: prevents pointless whitespace-only attribution or WMS styles from passing validation.
- **Where**: `src/validate.ts:47-59`.
- **How**: change the condition so the empty check uses `value === ''` (allowed) while a non-empty but
  whitespace-only value still fails. Add a validate test case.
- **Verification**: `npm test`, `npm run typecheck`.

### Plan item 4: Bump markdownlint-cli2 to 0.23.2 (L4)

- **What**: update the exact pin and refresh the lockfile.
- **Why**: stay current on the linting toolchain.
- **Where**: `package.json` devDependencies.
- **How**: set `"markdownlint-cli2": "0.23.2"`, run `npm install`, run `npm run lint:docs`.
- **Verification**: `npm run lint:docs`, `npm run verify:commit`.

### Plan item 5: Add upstream-monitor failure notification (L5)

- **What**: open or comment on a tracking GitHub issue when the weekly upstream monitor fails.
- **Why**: makes upstream drift durable and visible beyond a workflow-failure email.
- **Where**: `.github/workflows/upstream-monitor.yml`.
- **How**: add an `if: failure()` step after `check` using `actions/github-script` to search for an
  open "Upstream monitor failure" issue, comment on it if it exists, or create it if it does not.
  Keep the action SHA-pinned per the existing workflow convention.
- **Verification**: workflow syntax check via `npm run ci:workflows`, and a dry review of the script
  logic.

### Plan item 6 (optional): Reject duplicate template tokens (L3)

- **What**: assert each of `{z}`, `{x}`, `{y}` appears exactly once in XYZ and WMTS templates.
- **Why**: catches typos that currently produce valid but unintended URLs.
- **Where**: `src/validate.ts:144-155`.
- **How**: count occurrences of each token and assert equality to 1. Add a validate test case.
- **Verification**: `npm test`.
- **Note**: low value. Only do this if the team wants the stricter check.

### Plan item 7 (nit): Date REVIEW.md (N2)

- **What**: add a header to REVIEW.md noting it is the v0.4.0 review record, dated 2026-07-17.
- **Why**: prevents confusion about whether it reflects the current tree.
- **Where**: `REVIEW.md:1`.
- **How**: prepend a one-line dated note.
- **Verification**: `npm run lint:docs`.

## 5. What I would not change

These are by-design decisions confirmed correct during review. Preserved as a guard against
well-meaning regressions.

- **`estimateBytes` mode and default fallbacks stay unreachable.** Every catalog source carries an
  explicit `fallbackTileBytes`, so `DEFAULT_TILE_BYTES_BY_MODE` and `DEFAULT_TILE_BYTES` are not
  exercised inside `estimateBytes`. They remain exported for consumers and guard future optional
  entries. Plan item 2 locks this with a test.
- **WMS `TRANSPARENT=true` stays lowercase.** Keeps proxied requests byte-identical to the webapp
  (`src/expand.ts:44-53` comment).
- **Inclusive tile edges stay.** Overcounting boundary-aligned regions is deliberate for conservative
  warming (README, `test/mercator.test.ts:115-122`).
- **`prepare: tsc` lifecycle script stays.** The plugin-ci `npm pack --ignore-scripts` banner issue
  applies to Signal K plugins, not to this library. It is not a plugin, does not run under plugin-ci,
  and `scripts/package-smoke.mjs` already extracts the `npm pack` JSON report defensively. The script
  does not run for registry-tarball consumers.
- **Bit-exact `ORIGIN` constant.** `20037508.342789244` is the canonical Web Mercator extent, shared
  with the Rust container. Change both together (AGENTS.md).
- **Zero runtime dependencies, ESM-only, Node `>=22`.** Core to the isomorphic contract.
- **Style host port rejection.** Public CDN styles serve on 443 implicitly, and the catalog targets
  public services.

## 6. Verification summary

After applying any item above, run the full gate from AGENTS.md:

```bash
npm run typecheck
npm test
npm run test:coverage
npm run build
npm run test:package
npm audit
git diff --check
```

Run `npm run test:upstreams` when catalog data, source validation, or monitoring changes (plan items
1 and 5).
