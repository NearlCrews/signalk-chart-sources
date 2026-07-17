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
3. **Enforce Limits**: use count and estimate helpers for planning, then enforce request
   authorization, maximum tile counts, and actual transferred-byte limits in the consuming server.
4. **Handle Errors**: do not convert validation errors into unrestricted or worldwide requests.

## Dependency Security

This package has zero runtime dependencies. The only third-party code is the development
toolchain. We use:

- `npm audit` for vulnerability scanning
- Automated dependency updates via Dependabot for security patches
- Full commit SHA pins for GitHub Actions
- npm OIDC trusted publishing and a reviewer-protected deployment environment for releases

Run a security audit:

```bash
npm audit
npm audit --omit=dev
```

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
