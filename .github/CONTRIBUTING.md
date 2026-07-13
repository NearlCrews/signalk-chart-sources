# Contributing

Thanks for your interest in contributing to signalk-chart-sources.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to
uphold it.

## Reporting bugs

Check existing issues first to avoid duplicates, then open a bug report with:

- A clear title and description
- Steps to reproduce
- Expected and actual behavior
- Environment details (Node.js version, package version)
- A minimal code sample that triggers the issue

## Suggesting enhancements

Open a feature request issue describing the proposed change, the use case it serves, and any
implementation ideas you have. A new chart source, a new tile-math helper, and a change to the
byte estimate are all in scope.

## Pull requests

1. Fork the repository and create a feature branch from `main`.
2. Install the locked dependency tree with `npm ci`.
3. Make focused commits with clear messages (see below).
4. Add tests for any new functionality and keep the existing suites green.
5. Run `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`,
   `npm run test:package`, `npm audit`, and `git diff --check` before pushing.
6. Run `npm run test:upstreams` when catalog data, source validation, or monitor behavior changes.
7. Update `README.md`, `CHANGELOG.md`, public code comments, and templates affected by the change.
8. Open a pull request with a clear description of the change.

## Code style

- The package is TypeScript under `src/`, compiled to `dist/` by `tsc`. It targets Node.js 22 or
  newer and has zero runtime dependencies.
- Keep modules focused and small. Hoist shared logic into one place (a shared module or helper)
  rather than duplicating it. Prefer data-driven structures over parallel hard-coded lists.
- The package is data and pure helpers only: no MapLibre, no Signal K, and no Node or browser
  runtime APIs, so it stays usable from both the webapp and the tile-cache container.
- Do not edit `dist/`; it is generated build output.
- Keep public collections and catalog entries readonly and frozen.
- Reject invalid public inputs explicitly, and cap any operation that can allocate from caller input.
- Keep bbox units explicit. Use `LngLatBbox` for degrees and `MercatorBbox` for EPSG:3857 meters.
- Treat download estimates as planning data. Callers must enforce actual tile and byte limits.
- Default to no comments. Add one only when the WHY is non-obvious (a hidden constraint, a subtle
  invariant, or a workaround).

## Architecture rule

This repository ships exactly ONE npm package. Keep it modular by splitting the code into focused
files under `src/`. Never split the project into multiple npm packages or a monorepo.

The catalog and the tile math live here so the Binnacle chartplotter render config and the Chart
Locker tile-cache proxy allowlist derive from one definition. Any Web Mercator formula that must
agree with the Rust tile-cache container is kept bit-exact with the container copy; change both
together.

Live service checks belong in `scripts/check-upstreams.ts` and the scheduled upstream-monitor
workflow, not pull-request CI. Update the monitor whenever a source mode or capability invariant
changes.

## Public API changes

- Preserve root exports unless the change intentionally requires a breaking release.
- Document thrown errors, defaults, numeric limits, and readonly behavior.
- Add migration notes for changed runtime behavior, Node.js requirements, or TypeScript contracts.
- Test both the source tree and the packed package import and declaration surface.

## Commit messages

Use conventional-commit prefixes that match the actual diff scope:

```
feat: add a raster overlay source to the catalog
fix: deduplicate overlapping source coverage ranges
docs: update the public API section of the README
test: add coverage for the vector maxzoom clamp
chore: update dependencies
```

## License and attribution

By contributing, you agree your contributions are licensed under the MIT License that covers this
project.

Do not create release tags or publish packages from a contribution branch. Releases follow the
approval-gated process in [`RELEASING.md`](../RELEASING.md).
