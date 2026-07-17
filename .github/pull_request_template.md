# Pull Request

## Summary

<!-- 1-3 sentences: what changes and why. Link related issue with "Fixes #N" if applicable. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Dependency update

## Verification

- [ ] `npm run verify:commit` passes
- [ ] `npm test` passes
- [ ] `npm run test:coverage` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run build` passes
- [ ] `npm run test:package` passes
- [ ] `npm audit` and `npm audit --omit=dev` pass
- [ ] `git diff --check` passes
- [ ] Documentation and public code comments match the changed behavior

## Chart sources, tile math, and byte estimate affected

<!-- Optional. List added or changed chart sources (raster overlays, the vector basemap), Web Mercator tile-math helpers, URL-expansion helpers, or the byte estimate. Note: a Web Mercator formula that must agree with the Rust tile-cache container has to stay bit-exact with the container copy; change both together. Remove section if not applicable. -->

- [ ] Live capabilities and sample tiles were checked when catalog data changed
- [ ] `scripts/check-upstreams.ts` was updated when an upstream invariant changed
- [ ] `npm run test:upstreams` passes when catalog or monitoring behavior changed

## Breaking changes / migration

<!-- Remove section if not applicable. Otherwise describe the break and how consumers migrate. -->

- [ ] Node.js, thrown-error, readonly, numeric-limit, and consumer migration impacts are documented
