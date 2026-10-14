import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  assertAcceptedAudit,
  RUNTIME_DEPENDENCY_FIELDS
} from '../scripts/audit-policy.mjs'
import { readManifest } from '../scripts/records.mjs'

const ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
const RANGE = '<=3.0.3'
// The only fix npm finds today is a downgrade of markdownlint-cli2 to a release from years ago.
const BREAKING_FIX = { name: 'markdownlint-cli2', version: '0.0.4', isSemVerMajor: true }
const MANIFEST = { name: 'fixture', devDependencies: { 'markdownlint-cli2': '0.23.3' } }

type Entry = Record<string, unknown>
interface Report {
  auditReportVersion: number
  vulnerabilities: Record<string, Entry>
}

function entry(name: string, via: unknown[], effects: string[], severity = 'high'): Entry {
  return { name, severity, via, effects, nodes: [`node_modules/${name}`], fixAvailable: BREAKING_FIX }
}

/** The braces advisory as an audit cause, as reported today unless a field is overridden. */
function bracesCause(overrides: Entry = {}): Entry {
  return { name: 'braces', url: ADVISORY, severity: 'high', range: RANGE, ...overrides }
}

/** The braces chain as `npm audit --json` reports it today, trimmed to the fields the policy reads. */
function bracesReport(): Report {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: entry('braces', [bracesCause()], ['micromatch']),
      micromatch: entry('micromatch', ['braces'], ['fast-glob', 'globby', 'markdownlint-cli2']),
      'fast-glob': entry('fast-glob', ['micromatch'], ['globby']),
      globby: entry('globby', ['fast-glob', 'micromatch'], ['markdownlint-cli2']),
      'markdownlint-cli2': entry('markdownlint-cli2', ['globby', 'micromatch'], [])
    }
  }
}

/** A copy of the braces report with one entry's fields replaced. */
function patched(name: string, fields: Entry, report = bracesReport()): Report {
  report.vulnerabilities[name] = { ...report.vulnerabilities[name], ...fields }
  return report
}

const EMPTY: Report = { auditReportVersion: 2, vulnerabilities: {} }

test('the reviewed braces chain is the only accepted advisory, and it passes as reported', () => {
  assert.deepEqual(
    ACCEPTED_ADVISORIES.map(({ url }) => url),
    [ADVISORY]
  )
  assert.deepEqual(assertAcceptedAudit(bracesReport(), MANIFEST), { vulnerabilityCount: 5, advisoryCount: 1 })
})

test('with nothing accepted, a clean report passes and any finding fails closed', () => {
  assert.deepEqual(assertAcceptedAudit(EMPTY, MANIFEST, []), { vulnerabilityCount: 0, advisoryCount: 0 })
  assert.throws(() => assertAcceptedAudit(bracesReport(), MANIFEST, []), /Unexpected audited package: braces/)
})

test('an accepted advisory that disappears, or a chain that shrinks, is a stale exception', () => {
  assert.throws(() => assertAcceptedAudit(EMPTY, MANIFEST), /is no longer reported; remove it/)
  const shrunk = patched('micromatch', { effects: ['globby'] }, patched('globby', { via: ['micromatch'] }))
  delete shrunk.vulnerabilities['fast-glob']
  assert.throws(() => assertAcceptedAudit(shrunk, MANIFEST), /chain of .+ shrank; no longer reported: fast-glob/)
})

test('a patched release or a non-breaking fix ends the exception', () => {
  // A published fix narrows the advisory's vulnerable range, and the reviewed range no longer matches.
  const patchedUpstream = patched('braces', {
    via: [bracesCause({ range: '<3.0.4' })]
  })
  assert.throws(
    () => assertAcceptedAudit(patchedUpstream, MANIFEST),
    /now covers <3\.0\.4, not the reviewed <=3\.0\.3; check whether a patched release exists/
  )
  const withoutRange = patched('braces', { via: [bracesCause({ range: undefined })] })
  assert.throws(() => assertAcceptedAudit(withoutRange, MANIFEST), /now covers undefined/)

  // Once npm can clear a finding within the direct dependency's major, the update replaces the entry.
  for (const fixAvailable of [true, { ...BREAKING_FIX, version: '0.24.0', isSemVerMajor: false }]) {
    assert.throws(
      () => assertAcceptedAudit(patched('micromatch', { fixAvailable }), MANIFEST),
      /npm can now fix micromatch without a breaking change/
    )
  }
  assert.doesNotThrow(() => assertAcceptedAudit(patched('micromatch', { fixAvailable: false }), MANIFEST))
})

test('anything outside the accepted chain fails', () => {
  const extraPackage = bracesReport()
  extraPackage.vulnerabilities['lodash'] = { ...extraPackage.vulnerabilities['globby'], name: 'lodash' }
  assert.throws(() => assertAcceptedAudit(extraPackage, MANIFEST), /Unexpected audited package: lodash/)

  const extraAdvisory = patched('globby', {
    via: ['fast-glob', { name: 'globby', url: 'https://github.com/advisories/GHSA-example', severity: 'high' }]
  })
  assert.throws(() => assertAcceptedAudit(extraAdvisory, MANIFEST), /Unexpected advisory for globby/)

  const escalated = patched('braces', {
    severity: 'critical',
    via: [bracesCause({ severity: 'critical' })]
  })
  assert.throws(() => assertAcceptedAudit(escalated, MANIFEST), /Unexpected severity for braces: critical/)

  const widened = patched('globby', {
    via: ['fast-glob', bracesCause({ name: 'globby' })]
  })
  assert.doesNotThrow(() => assertAcceptedAudit(widened, MANIFEST))
  assert.throws(
    () => assertAcceptedAudit(patched('globby', { effects: ['markdownlint-cli2', 'cspell'] }, widened), MANIFEST),
    /Unexpected audit effect for globby: cspell/
  )

  const outsideTree = patched('braces', { nodes: ['../braces'] })
  assert.throws(() => assertAcceptedAudit(outsideTree, MANIFEST), /Unexpected audit node for braces/)

  const downgraded = patched('braces', { via: [bracesCause({ severity: 'moderate' })] })
  assert.throws(() => assertAcceptedAudit(downgraded, MANIFEST), /changed severity or reached braces/)
  const unnamed = patched('braces', { via: [{ name: 'braces', severity: 'high' }] })
  assert.throws(() => assertAcceptedAudit(unnamed, MANIFEST), /Malformed audit cause for braces/)
})

test('each advisory vouches only for its own chain, never for a package in another', () => {
  const other = 'https://github.com/advisories/GHSA-0000-0000-0000'
  const accepted: readonly AcceptedAdvisory[] = [
    ...ACCEPTED_ADVISORIES,
    { url: other, severity: 'moderate', range: '<1.0.0', packages: ['tar', 'request'] }
  ]
  const both = (): Report => {
    const report = bracesReport()
    report.vulnerabilities['tar'] = entry(
      'tar',
      [{ name: 'tar', url: other, severity: 'moderate', range: '<1.0.0' }],
      ['request'],
      'moderate'
    )
    report.vulnerabilities['request'] = entry('request', ['tar'], [], 'moderate')
    return report
  }
  assert.deepEqual(assertAcceptedAudit(both(), MANIFEST, accepted), { vulnerabilityCount: 7, advisoryCount: 2 })

  // Each of these would pass if the accepted packages, causes, effects, and severities were pooled.
  assert.throws(
    () => assertAcceptedAudit(patched('globby', { severity: 'moderate' }, both()), MANIFEST, accepted),
    /Unexpected severity for globby: moderate/
  )
  assert.throws(
    () => assertAcceptedAudit(patched('request', { via: ['tar', 'micromatch'] }, both()), MANIFEST, accepted),
    /Unexpected audit cause for request: micromatch/
  )
  assert.throws(
    () => assertAcceptedAudit(patched('tar', { effects: ['request', 'globby'] }, both()), MANIFEST, accepted),
    /Unexpected audit effect for tar: globby/
  )
  assert.throws(
    () => assertAcceptedAudit(patched('tar', { via: [bracesCause()] }, both()), MANIFEST, accepted),
    /changed severity or reached tar/
  )
})

test('the policy only holds while nothing third-party ships at runtime', () => {
  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    assert.throws(
      () => assertAcceptedAudit(bracesReport(), { ...MANIFEST, [field]: { braces: '3.0.3' } }),
      new RegExp(`package.json declares ${field}`)
    )
  }
  assert.doesNotThrow(() => assertAcceptedAudit(bracesReport(), { ...MANIFEST, dependencies: {} }))
  // The repository's own manifest, read as scripts/check-audit.mjs reads it, meets that precondition.
  const repository = readManifest(fileURLToPath(new URL('..', import.meta.url)))
  assert.deepEqual(assertAcceptedAudit(EMPTY, repository, []), { vulnerabilityCount: 0, advisoryCount: 0 })
  assert.throws(() => assertAcceptedAudit(bracesReport(), null), /package.json must be an object/)
})

test('reports the policy cannot read fail rather than pass', () => {
  assert.throws(() => assertAcceptedAudit({}, MANIFEST), /unsupported report/)
  assert.throws(
    () => assertAcceptedAudit({ auditReportVersion: 2, vulnerabilities: [] }, MANIFEST),
    /unsupported report/
  )
  assert.throws(
    () => assertAcceptedAudit({ error: { code: 'ENOTFOUND' } }, MANIFEST),
    /unsupported report/,
    'a failed audit request must not read as a clean audit'
  )
  const malformed = bracesReport()
  malformed.vulnerabilities['braces'] = { name: 'braces', severity: 'high' }
  assert.throws(() => assertAcceptedAudit(malformed, MANIFEST), /Malformed or changed audit entry for braces/)
  // A finding with no cause, or no word on whether a fix exists, cannot be matched to a reviewed one.
  for (const fields of [{ via: [] }, { fixAvailable: undefined }, { fixAvailable: 'yes' }]) {
    assert.throws(
      () => assertAcceptedAudit(patched('globby', fields), MANIFEST),
      /Malformed or changed audit entry for globby/
    )
  }
})
