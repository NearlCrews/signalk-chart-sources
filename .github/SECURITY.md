# Security Policy

## Supported Versions

Security fixes target the latest published release:

| Version                  | Supported |
| ------------------------ | --------- |
| Latest published release | Yes       |
| Earlier releases         | No        |

## Reporting a Vulnerability

We take the security of signalk-chart-sources seriously. If you discover a security
vulnerability, please follow these guidelines.

### How to Report

**Please do NOT report security vulnerabilities through public GitHub issues.**

Instead, please report them via one of these methods:

1. **GitHub Security Advisory**: Use the [GitHub Security Advisory](https://github.com/NearlCrews/signalk-chart-sources/security/advisories/new) feature (preferred).
2. **GitHub Issues**: For non-sensitive security concerns, open an [issue](https://github.com/NearlCrews/signalk-chart-sources/issues).

### What to Include

Please include the following information in your report:

- **Description** of the vulnerability
- **Steps to reproduce** the issue
- **Potential impact** of the vulnerability
- **Suggested fix** (if you have one)
- **Your contact information** for follow-up

### Response Timeline

- **Initial Response**: within 48 hours of report
- **Status Update**: within 7 days with a preliminary assessment
- **Fix Timeline**: depends on severity, typically within 30 days

## Security Best Practices

When depending on this package:

1. **Keep Updated**: use the latest published version and review its migration notes.
2. **Validate Inputs**: treat coordinates, boxes, zooms, source definitions, source ids, enumeration
   limits, and estimate statistics as untrusted at application boundaries.
3. **Constrain Destinations**: `validateChartSource` checks the shape of an upstream URL, not where it
   points. Only a `style` source carries a host allowlist. Apply your own host policy before building
   a request from a source definition that did not come from this catalog.
4. **Treat Attribution as Markup**: `attribution` is HTML, because renderers such as MapLibre
   insert it as HTML and catalog credits link to their licenses. Catalog attribution is reviewed
   markup. `validateChartSource` accepts only plain text and `<a href="https://...">` links,
   optionally with `target="_blank"`, as defense in depth, but that is not a sanitizer: sanitize
   attribution from any source definition that did not come from this catalog, or render it as text.
5. **Enforce Limits**: use count and estimate helpers for planning, then enforce request
   authorization, maximum tile counts, and actual transferred-byte limits in the consuming server.
6. **Handle Errors**: do not convert validation errors into unrestricted or worldwide requests.

## Dependency Security

This package has zero runtime dependencies. The only third-party code is the development
toolchain. We use:

- `npm audit` for vulnerability scanning, through a reviewed policy for development dependencies
- Automated dependency updates via Dependabot for security patches, with a seven-day cooldown for
  routine updates
- Full commit SHA pins for GitHub Actions, checked by actionlint and zizmor
- npm OIDC trusted publishing and a reviewer-protected deployment environment for releases

Run a security audit:

```bash
npm run audit:full
npm run audit:runtime
```

`audit:runtime` audits what ships and must stay clean. `audit:full` audits the development toolchain
too, and accepts only the advisories listed in `scripts/audit-policy.mjs`, each limited to the exact
package chain it reaches. It fails on any other finding, and on an accepted advisory that is no
longer reported, so an exception cannot outlive its cause.

### Accepted development advisories

- [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), high: stack exhaustion
  in `braces` from deeply nested brace patterns. No patched `braces` release exists. It reaches the
  toolchain only through `markdownlint-cli2`, by way of `globby`, `fast-glob`, and `micromatch`,
  which expand the glob patterns in `package.json` and `.markdownlint-cli2.jsonc`. Both files are
  part of the repository, so a hostile pattern would have to arrive as a repository change, which
  could run arbitrary code in CI anyway, and none of the chain ships in the published package. The
  exception ends when `braces` publishes a fix or the toolchain no longer depends on it; the audit
  then fails until the entry is removed.

### Development dependency overrides

When a patched release exists but a tool pins the vulnerable one, `package.json` overrides the pin
for that tool alone instead of accepting the advisory. Each override goes once the tool's own range
reaches the fix; `npm ls <package>` shows whether the override still changes anything.

- `markdownlint-cli2` > `smol-toml` 1.9.0, for
  [GHSA-r4xh-jqrq-34v2](https://github.com/advisories/GHSA-r4xh-jqrq-34v2) (moderate, quadratic-time
  parsing in 1.8.0 and earlier). `markdownlint-cli2` 0.23.3 pins 1.8.0. Drop it when a release of
  `markdownlint-cli2` depends on 1.9.0 or later.
- `micromark-extension-math` > `katex` 0.18.2, for
  [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) (low, prototype
  pollution bypassing trust restrictions before 0.18.2). `micromark-extension-math` 3.1.0 asks for
  `katex` ^0.16, and `markdownlint` loads it only for math syntax, never rendering with `katex`, so
  the newer release is safe there. Drop it when `micromark-extension-math` accepts a fixed `katex`.

## Data Handling

The published runtime is a pure library of static data and stateless helper functions. It makes no
network requests, opens no files, reads no environment, and handles no credentials or personal data.
The `expandUpstreamUrl` and `proxyTileTemplate` helpers build URL strings; the consuming application
performs the tile fetches. The catalog contains public services and no embedded keys or tokens.

The repository's maintenance scripts are different from the published runtime:

- `scripts/check-upstreams.ts` performs explicit live requests to public catalog services.
- `scripts/package-smoke.mjs` creates and removes a temporary directory while verifying the tarball.

## Signal K Security

This package is consumed by Signal K server plugins and webapps. Please also refer to the
[Signal K documentation](https://signalk.org/documentation/) and Signal K server security best
practices.

## Marine Safety Notice

This package defines the upstream chart and raster overlay sources used by marine navigation
software. The chart data those sources return, and any cache or render built from this catalog, is
advisory:

- **Not for Safety-Critical Use**: this software should not be relied upon as the sole means of
  navigation.
- **Professional Equipment**: always maintain certified navigation equipment.
- **Regular Verification**: verify all navigation data against official charts and notices to
  mariners.

## Disclosure Policy

- We will coordinate disclosure timing with the reporter.
- Public disclosure will occur after a fix is available.
- Credit will be given to reporters (if desired).
- A security advisory will be published on GitHub.
