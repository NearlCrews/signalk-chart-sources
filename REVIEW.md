# Code Review Plan: signalk-chart-sources v0.4.0

Historical record: this review was completed 2026-07-17 for the v0.4.0 release and does not reflect
later changes. See CODE_REVIEW.md for the follow-up review of the current tree.

## Methodology

Read every source, test, script, config, CI workflow, and doc file in the repo. Query Context7
for latest best practices on all direct and transitive dependencies. Run the full verification
suite (build, type-check, tests, coverage, lint, deadcode, spellcheck, package smoke).

## Categories inspected

### Dependencies

- npm outdated (all), npm audit (runtime and dev), package.json engines and scripts

### TypeScript configuration

- tsconfig.json and tsconfig.test.json against TS 7.0 `tsc --init` recommended options
- isolation, erasable-syntax, declaration emit, module detection, side-effect imports

### Linting and formatting

- Biome config: preset, assists, rule overrides, organize-imports form
- Knip config: dead code, cycles, config-hint treatment
- cspell dictionary, markdownlint pass

### Security

- URL validation, credential rejection, input size limits, upstream mode exhaustiveness
- fast-xml-parser hardening in the upstream monitoring script
- npm publish workflow: OIDC, protected environment, tarball provenance

### Source catalog

- 16 chart sources across XYZ, WMTS, WMS, ArcGIS, and vector-style modes
- Bounds, attribution, tile sizes, zoom ranges, drift-guard tests
- Immutability audit and group consistency

### Tile math

- Bit-exact ORIGIN constant and Web Mercator formulas
- Antimeridian splitting, coverage clipping, disjoint-range deduplication
- Count vs. enumerate: lazy iterator, array, defensive maxTiles
- Forward and inverse invariants

### URL expansion

- XYZ/WMTS token substitution, WMS GetMap parameter assembly, ArcGIS Export query, style passthrough
- Proxy tile template construction and trailing-slash normalization

### Estimation

- Per-source averages, mode fallbacks, safe-integer overflow rejection
- Unknown-source and out-of-bounds behavior

### Tests

- 53 tests: catalog, expand, mercator, validate, estimate, fixtures
- Coverage thresholds (≥90% lines, ≥90% functions, ≥85% branches)
- Deterministic random-sampling invariant tests

### CI and release

- CI matrix (Node 22, 24, 26), verify:commit, coverage, package smoke, audit
- npm-publish: tag verification, tarball provenance, OIDC publishing
- Upstream monitor: weekly schedule, WMS/WMTS capability checks

## Findings and resolutions

### Fixed

- WMS and ArcGIS base URLs ending in a bare `?` or `#` passed validation but produced a broken
  GetMap query after parameter appending. Validation now rejects both raw markers.
- XYZ and WMTS templates could place `{z}`, `{x}`, or `{y}` in the host. Templates must now start
  with `https://` and keep tokens out of the authority.
- `allowedHosts` entries with an explicit default port (`host:443`) bypassed the port rejection.
  Hosts now reject `:` outright.
- WMS layer, style, and format values accepted `+`, which some servers decode as a space. The query
  value character ban now includes `+`.
- `proxyTileTemplate` accepted plugin bases containing whitespace, controls, `?`, `#`, and braces.
- `estimateBytes` double-counted duplicated source ids; duplicates now count once.
- `deepFreeze` froze after recursing, so a cyclic reference would recurse forever, and symbol-keyed
  properties were skipped. It now freezes first and walks `Reflect.ownKeys`.
- `check-workflows.mjs` only pin-checked `- uses:` list items, missing `uses:` under named steps.
- `package-smoke.mjs` parsed raw `npm pack --json` stdout, which npm lifecycle banners can corrupt
  on npm 10; the JSON report is now extracted defensively.
- The upstream monitor XML parser had unbounded entity expansion; it now caps entity count, size,
  total expansions, expanded length, and nesting depth.
- The upstream monitor workflow gained a concurrency group; CI fetches full history only on the
  lane that diffs commit ranges.
- tsconfig moved to target and lib ES2023 with Node.js types, dropping the DOM lib.
- devDependencies are now exactly pinned and current (biome 2.5.5, knip 6.29.0, publint 0.3.22),
  and an override moves js-yaml to 5.2.2 to clear GHSA-pm4m-ph32-ghv5.
- README URL-construction, estimate, and migration sections and the stale RELEASING.md versioning
  sentence were brought current; the npm version pin in the publish workflow is now documented.
- A mislabeled estimate test name and a stale unreachable-branch comment were corrected.

### By design, unchanged

- `estimateBytes` resolves catalog ids only, so `DEFAULT_TILE_BYTES` and
  `DEFAULT_TILE_BYTES_BY_MODE` stay unreachable inside it while every catalog entry carries an
  explicit `fallbackTileBytes`. The constants remain exported for consumers, and the fallback chain
  guards future optional entries.
- WMS `TRANSPARENT=true` stays lowercase to keep proxied requests byte-identical to the webapp.
- Inclusive tile edges overcount boundary-aligned regions deliberately for conservative warming.
- Catalog entries keep explicit `fallbackTileBytes` values so consumers never depend on library
  defaults.
- `test:package` builds before packing even though `prepare` rebuilds, keeping failures attributable.
