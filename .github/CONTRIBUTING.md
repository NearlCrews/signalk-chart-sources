# Contributing

Thanks for your interest in contributing to signalk-chart-sources.

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you agree to
uphold it.

## Reporting bugs

Check existing issues first to avoid duplicates, then open a bug report with:

- A clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment details (Node.js version, package version)
- A minimal code sample that triggers the issue

## Suggesting enhancements

Open a feature request issue describing the proposed change, the use case it serves, and any
implementation ideas you have. A new chart source, a new tile-math helper, and a change to the
byte estimate are all in scope.

## Pull requests

1. Fork the repository and create a feature branch from `main`.
2. Install dependencies with `npm install`.
3. Make focused commits with clear messages (see below).
4. Add tests for any new functionality and keep the existing suites green.
5. Run `npm run typecheck`, `npm test`, and `npm run build` before pushing.
6. Update documentation (`README.md`, `CHANGELOG.md`) as needed.
7. Open a pull request with a clear description of the change.

## Code style

- The package is TypeScript under `src/`, compiled to `dist/` by `tsc`. It targets Node.js 20 or
  newer and has zero runtime dependencies.
- Keep modules focused and small. Hoist shared logic into one place (a shared module or helper)
  rather than duplicating it. Prefer data-driven structures over parallel hard-coded lists.
- The package is data and pure helpers only: no MapLibre, no Signal K, and no Node or browser
  runtime APIs, so it stays usable from both the webapp and the tile-cache container.
- Do not edit `dist/`; it is generated build output.
- Default to no comments. Add one only when the WHY is non-obvious (a hidden constraint, a subtle
  invariant, or a workaround).

## Architecture rule

This repository ships exactly ONE npm package. Keep it modular by splitting the code into focused
files under `src/`. Never split the project into multiple npm packages or a monorepo.

The catalog and the tile math live here so the Binnacle chartplotter render config and the Chart
Locker tile-cache proxy allowlist derive from one definition. Any Web Mercator formula that must
agree with the Rust tile-cache container is kept bit-exact with the container copy; change both
together.

## Commit messages

Use conventional-commit prefixes that match the actual diff scope:

```
feat: add a raster overlay source to the catalog
fix: correct the antimeridian guard in tilesInBbox
docs: update the public API section of the README
test: add coverage for the vector maxzoom clamp
chore: update dependencies
```

## License and attribution

By contributing, you agree your contributions are licensed under the MIT License that covers this
project.
