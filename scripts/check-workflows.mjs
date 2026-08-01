import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const workflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/npm-publish.yml',
  '.github/workflows/upstream-monitor.yml'
]
// Job-level permission escalations, keyed by "<workflow>#<job>". Anything absent here must run with
// the read-only workflow default.
const allowedJobPermissions = new Map([
  ['.github/workflows/npm-publish.yml#publish', { 'id-token': 'write', contents: 'read' }],
  ['.github/workflows/upstream-monitor.yml#track', { contents: 'read', issues: 'write' }]
])
const expectedActions = new Map([
  ['actions/checkout', '9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0'],
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
  ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
  ['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'],
  ['actions/github-script', 'ed597411d8f924073f98dfc5c65a23a2325f34cd']
])

function object(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  return value
}

for (const path of workflows) {
  const source = readFileSync(path, 'utf8')
  const workflow = object(parse(source), path)
  const permissions = object(workflow.permissions, `${path} permissions`)
  assert.deepEqual(permissions, { contents: 'read' }, `${path} must default to read-only contents`)

  for (const match of source.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)(?:\s+#.*)?$/gmu)) {
    const reference = match[1]
    assert.ok(reference, `${path} contains an empty action reference`)
    if (reference.startsWith('./')) continue
    const [action, sha] = reference.split('@')
    // Check the pin and the allowlist separately. Comparing only against the map lets an unpinned
    // reference to an unreviewed action pass, because both sides come back undefined.
    assert.match(sha ?? '', /^[0-9a-f]{40}$/, `${path} must pin ${action} to a full commit SHA`)
    assert.ok(expectedActions.has(action), `${path} uses an unreviewed action: ${action}`)
    assert.equal(sha, expectedActions.get(action), `${path} must use the reviewed ${action} SHA`)
  }

  // Every job that widens permissions beyond the read-only default must be listed here, so a new
  // write scope has to be reviewed rather than merely declared.
  const jobs = object(workflow.jobs, `${path} jobs`)
  for (const [name, job] of Object.entries(jobs)) {
    const scopes = object(job, `${path} job ${name}`).permissions
    if (scopes === undefined) continue
    const expected = allowedJobPermissions.get(`${path}#${name}`)
    assert.ok(expected, `${path} job ${name} declares unreviewed permissions: ${JSON.stringify(scopes)}`)
    assert.deepEqual(scopes, expected, `${path} job ${name} must keep its reviewed permissions`)
  }

  // Read the steps structurally rather than slicing a window of text around each checkout line. A
  // textual window has to guess where the step ends, and guessing long lets a later step's setting
  // satisfy an earlier checkout that never had one.
  for (const [name, job] of Object.entries(jobs)) {
    const steps = object(job, `${path} job ${name}`).steps ?? []
    for (const step of steps) {
      const uses = object(step, `${path} job ${name} step`).uses
      if (typeof uses !== 'string' || !uses.startsWith('actions/checkout@')) continue
      const options = step.with
      assert.equal(
        options && typeof options === 'object' ? options['persist-credentials'] : undefined,
        false,
        `${path} job ${name} must disable checkout credentials`
      )
    }
  }
}

const ci = readFileSync('.github/workflows/ci.yml', 'utf8')
assert.match(ci, /name:\s+CI success/, 'CI must expose the stable CI success gate')
assert.match(ci, /run:\s+npm run verify:commit/, 'CI must run repository quality checks')
assert.match(ci, /git diff --check/, 'CI must check the actual commit or pull-request diff')

const publish = readFileSync('.github/workflows/npm-publish.yml', 'utf8')
const publishCommand = 'npm publish "./' + '$' + '{packages[0]}" --provenance --access public'
for (const required of [
  'cancel-in-progress: false',
  'fetch-depth: 0',
  'RELEASE_PRERELEASE',
  'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
  'node scripts/package-smoke.mjs package',
  'id-token: write',
  'environment: npm',
  'packages=(package/*.tgz)',
  publishCommand
]) {
  assert.ok(publish.includes(required), `publish workflow is missing: ${required}`)
}
assert.equal((publish.match(/npm publish/g) ?? []).length, 1, 'publish workflow must have one npm publish command')
assert.equal(
  (publish.match(/npm pack(?:\s|$)/g) ?? []).length,
  0,
  'publish workflow must pack only through package smoke'
)

console.log('Workflow security and publication invariants verified.')
