import { readFileSync } from 'node:fs'
import { assertAcceptedAudit } from './audit-policy.mjs'
import { readManifest } from './records.mjs'

/** @type {unknown} */
let report
try {
  report = JSON.parse(readFileSync(0, 'utf8'))
} catch (error) {
  throw new Error('npm audit returned invalid JSON', { cause: error })
}

const accepted = assertAcceptedAudit(report, readManifest('.'))

console.log(
  accepted.vulnerabilityCount === 0
    ? 'Full dependency audit is clean.'
    : `Accepted ${accepted.vulnerabilityCount} development-only findings from ${accepted.advisoryCount} reviewed ` +
        `${accepted.advisoryCount === 1 ? 'advisory' : 'advisories'} listed in scripts/audit-policy.mjs.`
)
