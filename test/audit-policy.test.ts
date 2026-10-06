import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  assertAcceptedAudit,
  RUNTIME_DEPENDENCY_FIELDS
} from '../scripts/audit-policy.mjs'

const ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
const MANIFEST = { name: 'fixture', devDependencies: { 'markdownlint-cli2': '0.23.3' } }

type Entry = Record<string, unknown>
interface Report {
  auditReportVersion: number
  vulnerabilities: Record<string, Entry>
}

function entry(name: string, via: unknown[], effects: string[], severity = 'high'): Entry {
  return { name, severity, via, effects, nodes: [`node_modules/${name}`] }
}

/** The braces chain as `npm audit --json` reports it today, trimmed to the fields the policy reads. */
function bracesReport(): Report {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      braces: entry('braces', [{ name: 'braces', url: ADVISORY, severity: 'high' }], ['micromatch']),
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
    via: [{ name: 'braces', url: ADVISORY, severity: 'critical' }]
  })
  assert.throws(() => assertAcceptedAudit(escalated, MANIFEST), /Unexpected severity for braces: critical/)

  const widened = patched('globby', { via: ['fast-glob', { name: 'globby', url: ADVISORY, severity: 'high' }] })
  assert.doesNotThrow(() => assertAcceptedAudit(widened, MANIFEST))
  assert.throws(
    () => assertAcceptedAudit(patched('globby', { effects: ['markdownlint-cli2', 'cspell'] }, widened), MANIFEST),
    /Unexpected audit effect for globby: cspell/
  )

  const outsideTree = patched('braces', { nodes: ['../braces'] })
  assert.throws(() => assertAcceptedAudit(outsideTree, MANIFEST), /Unexpected audit node for braces/)

  const downgraded = patched('braces', { via: [{ name: 'braces', url: ADVISORY, severity: 'moderate' }] })
  assert.throws(() => assertAcceptedAudit(downgraded, MANIFEST), /changed severity or reached braces/)
  const unnamed = patched('braces', { via: [{ name: 'braces', severity: 'high' }] })
  assert.throws(() => assertAcceptedAudit(unnamed, MANIFEST), /Malformed audit cause for braces/)
})

test('each advisory vouches only for its own chain, never for a package in another', () => {
  const other = 'https://github.com/advisories/GHSA-0000-0000-0000'
  const accepted: readonly AcceptedAdvisory[] = [
    ...ACCEPTED_ADVISORIES,
    { url: other, severity: 'moderate', packages: ['tar', 'request'] }
  ]
  const both = (): Report => {
    const report = bracesReport()
    report.vulnerabilities['tar'] = entry(
      'tar',
      [{ name: 'tar', url: other, severity: 'moderate' }],
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
    () =>
      assertAcceptedAudit(
        patched('tar', { via: [{ name: 'braces', url: ADVISORY, severity: 'high' }] }, both()),
        MANIFEST,
        accepted
      ),
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
})
