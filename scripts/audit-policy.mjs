import { isRecord, object } from './records.mjs'

/**
 * @typedef {{ readonly url: string, readonly severity: string, readonly packages: readonly string[] }} AcceptedAdvisory
 * @typedef {{
 *   readonly severity: string,
 *   readonly via: readonly unknown[],
 *   readonly effects: readonly unknown[],
 *   readonly nodes: readonly unknown[]
 * }} AuditEntry
 */

/**
 * Development-only advisories this repository has reviewed and accepted, each with the exact package
 * chain it reaches. The full audit fails on anything else, on a chain that grows or shrinks, and on an
 * accepted advisory that is no longer reported, so an exception cannot outlive its cause.
 *
 * @type {readonly AcceptedAdvisory[]}
 */
export const ACCEPTED_ADVISORIES = Object.freeze([
  Object.freeze({
    // braces has no patched release. It reaches the tree only through markdownlint-cli2, which
    // expands the glob patterns in package.json and .markdownlint-cli2.jsonc, both repository
    // controlled, and nothing in the chain ships in the published package. Remove this entry once
    // braces publishes a fix or markdownlint-cli2 stops depending on micromatch.
    url: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    severity: 'high',
    packages: Object.freeze(['braces', 'fast-glob', 'globby', 'markdownlint-cli2', 'micromatch'])
  })
])

/** Manifest fields that would put a third-party package into the published runtime. */
export const RUNTIME_DEPENDENCY_FIELDS = Object.freeze(['dependencies', 'optionalDependencies', 'peerDependencies'])

/**
 * @param {unknown} report
 * @returns {Record<string, unknown>}
 */
function vulnerabilitiesFrom(report) {
  if (!isRecord(report) || report['auditReportVersion'] !== 2 || !isRecord(report['vulnerabilities'])) {
    throw new Error('npm audit returned an unsupported report')
  }
  return report['vulnerabilities']
}

/**
 * Every finding is development-only by construction while the package has no runtime dependencies,
 * which is what makes the accepted advisories above acceptable at all.
 *
 * @param {unknown} manifest
 */
function assertNoRuntimeDependencies(manifest) {
  const fields = object(manifest, 'package.json')
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const value = fields[field]
    if (value !== undefined && (!isRecord(value) || Object.keys(value).length > 0)) {
      throw new Error(`package.json declares ${field}; the audit policy assumes a dependency-free runtime`)
    }
  }
}

/**
 * @param {string} name
 * @param {unknown} entry
 * @returns {AuditEntry}
 */
function auditEntry(name, entry) {
  if (
    !isRecord(entry) ||
    typeof entry['severity'] !== 'string' ||
    !Array.isArray(entry['via']) ||
    !Array.isArray(entry['effects']) ||
    !Array.isArray(entry['nodes'])
  ) {
    throw new Error(`Malformed or changed audit entry for ${name}`)
  }
  return { severity: entry['severity'], via: entry['via'], effects: entry['effects'], nodes: entry['nodes'] }
}

/**
 * Accept a full `npm audit --json` report only if it matches the accepted advisories exactly.
 *
 * @param {unknown} report
 * @param {unknown} manifest
 * @param {readonly AcceptedAdvisory[]} [accepted]
 * @returns {{ vulnerabilityCount: number, advisoryCount: number }}
 */
export function assertAcceptedAudit(report, manifest, accepted = ACCEPTED_ADVISORIES) {
  const vulnerabilities = vulnerabilitiesFrom(report)
  assertNoRuntimeDependencies(manifest)

  const byUrl = new Map(accepted.map((advisory) => [advisory.url, advisory]))
  /** @type {Set<string>} */
  const seenUrls = new Set()

  for (const [name, value] of Object.entries(vulnerabilities)) {
    // Only an advisory whose reviewed chain holds this package can account for it, so a severity, a
    // cause, or an effect accepted for one chain cannot vouch for a package in another.
    const chains = accepted.filter((advisory) => advisory.packages.includes(name))
    if (chains.length === 0) throw new Error(`Unexpected audited package: ${name}`)
    /** @param {string} other */
    const sharesChain = (other) => chains.some((advisory) => advisory.packages.includes(other))
    const entry = auditEntry(name, value)
    if (!chains.some((advisory) => advisory.severity === entry.severity)) {
      throw new Error(`Unexpected severity for ${name}: ${entry.severity}`)
    }
    for (const cause of entry.via) {
      if (typeof cause === 'string') {
        if (!sharesChain(cause)) throw new Error(`Unexpected audit cause for ${name}: ${cause}`)
        continue
      }
      if (!isRecord(cause) || typeof cause['url'] !== 'string') {
        throw new Error(`Malformed audit cause for ${name}`)
      }
      const advisory = byUrl.get(cause['url'])
      if (!advisory) throw new Error(`Unexpected advisory for ${name}: ${cause['url']}`)
      if (cause['severity'] !== advisory.severity || !advisory.packages.includes(name)) {
        throw new Error(`Advisory ${advisory.url} changed severity or reached ${name}`)
      }
      seenUrls.add(advisory.url)
    }
    for (const effect of entry.effects) {
      if (typeof effect !== 'string' || !sharesChain(effect)) {
        throw new Error(`Unexpected audit effect for ${name}: ${String(effect)}`)
      }
    }
    if (
      entry.nodes.length === 0 ||
      entry.nodes.some((node) => typeof node !== 'string' || !node.startsWith('node_modules/'))
    ) {
      throw new Error(`Unexpected audit node for ${name}`)
    }
  }

  for (const advisory of accepted) {
    if (!seenUrls.has(advisory.url)) {
      throw new Error(
        `Accepted advisory ${advisory.url} is no longer reported; remove it from scripts/audit-policy.mjs`
      )
    }
    const missing = advisory.packages.filter((name) => !Object.hasOwn(vulnerabilities, name))
    if (missing.length > 0) {
      throw new Error(`Accepted chain of ${advisory.url} shrank; no longer reported: ${missing.join(', ')}`)
    }
  }

  return { vulnerabilityCount: Object.keys(vulnerabilities).length, advisoryCount: seenUrls.size }
}
