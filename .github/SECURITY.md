# Security Policy

## Supported Versions

We actively support the following versions with security updates:

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

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

1. **Keep Updated**: always use the latest version.
2. **Review Dependencies**: regularly update your dependency tree and run `npm audit`.
3. **Validate Inputs**: the tile-math and URL-building helpers assume the caller passes bounded,
   finite coordinates; validate untrusted input before handing it to them.

## Dependency Security

This package has zero runtime dependencies. The only third-party code is the development
toolchain (TypeScript and tsx). We use:

- `npm audit` for vulnerability scanning
- Automated dependency updates via Dependabot for security patches

Run a security audit:

```bash
npm audit
```

## Data Handling

signalk-chart-sources is a pure library of static data and stateless helper functions. It makes
no network requests, opens no files, reads no environment, and handles no credentials or personal
data of any kind. The `expandUpstreamUrl` and `proxyTileTemplate` helpers build URL strings; the
consuming application is what performs the actual tile fetches. The catalog lists the public chart
and raster overlay services those requests target, with no embedded keys or tokens.

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
