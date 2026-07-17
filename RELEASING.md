# Releasing

Publishing requires two explicit approvals:

1. Approval to create the version tag and publish the GitHub release.
2. Approval of the protected `npm` deployment environment before npm publication.

Do not create a tag, publish a GitHub release, or approve npm deployment without final maintainer
approval.

## One-time trusted-publishing setup

The repository must have an `npm` environment with a required reviewer. The workflow references that
environment and requests `id-token: write` only in the publish job.

The trusted-publisher workflow must exist on the default branch before it can be registered with npm.
From an npm-authenticated CLI using a current npm release with trusted-publishing support, run:

```bash
npm trust github signalk-chart-sources \
  --file npm-publish.yml \
  --repo NearlCrews/signalk-chart-sources \
  --env npm \
  --allow-publish \
  --yes
```

Confirm the relationship:

```bash
npm trust list signalk-chart-sources
```

After one successful OIDC publication, remove the repository's legacy `NPM_TOKEN` secret, revoke the
corresponding npm automation token, and confirm the workflow still publishes without token fallback.

## Prepare a release

1. Confirm the working tree contains only intended changes.
2. Choose the version according to the actual compatibility impact. The current Unreleased section
   contains breaking runtime and type-contract changes, so it requires a new minor version while the
   package remains below 1.0.0.
3. Replace the Unreleased changelog content with a dated release section, then add a fresh Unreleased
   heading and update comparison links.
4. Update `package.json` and `package-lock.json` without creating a tag:

   ```bash
   npm version <version> --no-git-tag-version
   ```

5. Run the complete local sequence:

   ```bash
   npm ci
   npm run verify
   npm run test:upstreams
   git diff --check
   ```

6. Confirm README requirements, migration notes, package metadata, changelog links, public exports,
   packed files, and source-monitor expectations match the release.
7. Confirm known consumers still use a pre-release dependency range or have passed their documented
   migration checks. A breaking pre-1.0 release must not enter a consumer through an existing range.
8. Commit and push the release preparation without creating a tag.
9. Confirm CI is green on the exact commit and the most recent upstream monitor is green.

## Publish

1. Obtain explicit final approval to create the version tag and GitHub release.
2. Create an annotated `v<version>` tag on the verified commit and push it.
3. Create a stable, non-prerelease GitHub release from that tag. The workflow rejects a tag that does
   not match `package.json`, a prerelease version, or a commit that is not reachable from `main`.
4. The verify job installs the lockfile, runs repository quality checks, builds, type-checks, runs
   tests, coverage, and audits, creates one tarball, validates it with Publint, smoke-tests its runtime
   and declarations in an installed consumer, and uploads that exact artifact.
5. Inspect the pending deployment, then approve the protected `npm` environment. This is the final
   approval before npm publication.
6. The publish job downloads the verified tarball and publishes it through npm OIDC with provenance.

## Verify publication

Confirm all of the following against the published version:

- The npm `latest` dist-tag points to the intended version.
- Package provenance links to the expected repository, workflow, tag, and commit.
- The tarball contains `dist`, declarations, `package.json`, `README.md`, `CHANGELOG.md`,
  `MIGRATING.md`, and `LICENSE`, with no source tests, maintenance scripts, or local files.
- A clean ESM project can install and import the package root.
- The published declarations resolve under `moduleResolution: NodeNext`.
- GitHub CI and the publish workflow are green on the tagged commit.

Useful read-only checks:

```bash
npm view signalk-chart-sources version dist-tags dist.attestations --json
npm view signalk-chart-sources@<version> dist.tarball
```

Do not republish or move a tag to repair a bad release. Prepare a new patch release.
