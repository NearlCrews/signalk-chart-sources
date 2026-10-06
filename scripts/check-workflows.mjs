import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { isRecord, object } from './records.mjs'

const CI = '.github/workflows/ci.yml'
const PUBLISH = '.github/workflows/npm-publish.yml'
const MONITOR = '.github/workflows/upstream-monitor.yml'
const workflows = [CI, PUBLISH, MONITOR, '.github/workflows/workflow-security.yml']
// Every workflow on disk must be one of the reviewed ones above. A workflow left off that list would
// skip every check below, including the trigger and permission rules.
const onDisk = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`)
  .sort()
assert.deepEqual(
  onDisk,
  [...workflows].sort(),
  `.github/workflows must hold exactly the reviewed workflows; add a new one to scripts/check-workflows.mjs ` +
    `only after review. On disk: ${onDisk.join(', ')}`
)

// Job-level permission escalations, keyed by "<workflow>#<job>". Anything absent here must run with
// the read-only workflow default.
const allowedJobPermissions = new Map([
  [`${PUBLISH}#publish`, { 'id-token': 'write', contents: 'read' }],
  [`${MONITOR}#track`, { contents: 'read', issues: 'write' }]
])
const expectedActions = new Map([
  ['actions/checkout', '3d3c42e5aac5ba805825da76410c181273ba90b1'],
  ['actions/setup-node', '820762786026740c76f36085b0efc47a31fe5020'],
  ['actions/setup-go', 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e'],
  ['actions/upload-artifact', '043fb46d1a93c77aae656e7c1c64a875d1fc6a0a'],
  ['actions/download-artifact', '3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c'],
  ['actions/github-script', '3a2844b7e9c422d3c10d287c895573f7108da1b3'],
  ['zizmorcore/zizmor-action', 'cc914d7f3750a2d13d75c7f184a1060aa0e9d482']
])
// Triggers that run with write access or secrets in the context of code the repository did not
// review. Nothing here needs them, so none may appear.
const forbiddenTriggers = ['pull_request_target', 'workflow_run']

/**
 * @param {Record<string, unknown>} workflow
 * @param {string} name
 * @returns {Record<string, unknown>}
 */
function jobOf(workflow, name) {
  return object(object(workflow['jobs'], 'jobs')[name], `job ${name}`)
}

/**
 * @param {Record<string, unknown>} workflow
 * @param {string} name
 * @returns {Record<string, unknown>[]}
 */
function stepsOf(workflow, name) {
  const steps = jobOf(workflow, name)['steps'] ?? []
  assert.ok(Array.isArray(steps), `job ${name} steps must be an array`)
  return steps.map((step) => object(step, `job ${name} step`))
}

/**
 * Every command line a job's run steps execute, trimmed, without blank lines or shell comments. Parsed
 * YAML carries no comments either, so a note that mentions a command can neither satisfy nor trip a
 * check.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @returns {string[]}
 */
function runCommands(workflow, job) {
  return stepsOf(workflow, job).flatMap((step) =>
    typeof step['run'] === 'string'
      ? step['run']
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '' && !line.startsWith('#'))
      : []
  )
}

/**
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @param {readonly string[]} commands
 * @param {string} label
 */
function assertRuns(workflow, job, commands, label) {
  const lines = runCommands(workflow, job)
  for (const command of commands) assert.ok(lines.includes(command), `${label} must run: ${command}`)
}

/** @type {Map<string, Record<string, unknown>>} */
const parsed = new Map()

// Everything below reads the parsed jobs and steps structurally rather than scanning raw text. A
// textual scan cannot tell a real step from a comment or an embedded script line that merely looks
// like one, and it has to guess where a step ends, which lets a later step's setting satisfy an
// earlier checkout that never had one.
for (const path of workflows) {
  const workflow = object(parse(readFileSync(path, 'utf8')), path)
  parsed.set(path, workflow)
  const permissions = object(workflow['permissions'], `${path} permissions`)
  assert.deepEqual(permissions, { contents: 'read' }, `${path} must default to read-only contents`)
  const triggers = typeof workflow['on'] === 'string' ? [workflow['on']] : Object.keys(object(workflow['on'], path))
  for (const trigger of forbiddenTriggers) {
    assert.ok(!triggers.includes(trigger), `${path} must not use the ${trigger} trigger`)
  }

  for (const name of Object.keys(object(workflow['jobs'], `${path} jobs`))) {
    const details = jobOf(workflow, name)

    // Every job that widens permissions beyond the read-only default must be listed here, so a new
    // write scope has to be reviewed rather than merely declared.
    if (details['permissions'] !== undefined) {
      const expected = allowedJobPermissions.get(`${path}#${name}`)
      assert.ok(
        expected,
        `${path} job ${name} declares unreviewed permissions: ${JSON.stringify(details['permissions'])}`
      )
      assert.deepEqual(details['permissions'], expected, `${path} job ${name} must keep its reviewed permissions`)
    }

    // The full audit goes through the reviewed policy in scripts/audit-policy.mjs. A bare npm audit
    // either fails on every accepted advisory or, with a lowered level, silently passes new ones.
    for (const line of runCommands(workflow, name)) {
      assert.doesNotMatch(
        line,
        /\bnpm audit\b/,
        `${path} job ${name} must audit through npm run audit:full or audit:runtime`
      )
    }

    // A job-level uses references a reusable workflow and faces the same review rules as an action.
    /** @type {string[]} */
    const references = typeof details['uses'] === 'string' ? [details['uses']] : []
    for (const step of stepsOf(workflow, name)) {
      const uses = step['uses']
      if (typeof uses !== 'string') continue
      references.push(uses)
      const options = isRecord(step['with']) ? step['with'] : {}
      if (uses.startsWith('actions/checkout@')) {
        assert.equal(options['persist-credentials'], false, `${path} job ${name} must disable checkout credentials`)
      }
      // A release build restores nothing from a cache that other workflow runs can write.
      if (path === PUBLISH && uses.startsWith('actions/setup-node@')) {
        assert.equal(options['package-manager-cache'], false, `${path} job ${name} must disable the npm cache`)
        assert.equal(options['cache'], undefined, `${path} job ${name} must not restore a cache`)
      }
    }

    for (const reference of references) {
      if (reference.startsWith('./')) continue
      const [action, sha] = reference.split('@')
      // Check the pin and the allowlist separately. Comparing only against the map lets an unpinned
      // reference to an unreviewed action pass, because both sides come back undefined.
      assert.match(sha ?? '', /^[0-9a-f]{40}$/, `${path} must pin ${action} to a full commit SHA`)
      assert.ok(action && expectedActions.has(action), `${path} uses an unreviewed action: ${action}`)
      assert.equal(sha, expectedActions.get(action), `${path} must use the reviewed ${action} SHA`)
    }
  }
}

const ci = object(parsed.get(CI), CI)
assert.equal(jobOf(ci, 'ci-success')['name'], 'CI success', 'CI must expose the stable CI success gate')
assertRuns(
  ci,
  'build',
  [
    'npm run verify:commit',
    'npm run test:coverage',
    'npm run test:package',
    'npm run audit:full',
    'npm run audit:runtime'
  ],
  'CI'
)
assert.ok(
  runCommands(ci, 'build').some((line) => line.startsWith('git diff --check')),
  'CI must check the actual commit or pull-request diff'
)

const publish = object(parsed.get(PUBLISH), PUBLISH)
assert.equal(
  object(publish['concurrency'], `${PUBLISH} concurrency`)['cancel-in-progress'],
  false,
  'a release publication must never be cancelled part way'
)
const publishJob = jobOf(publish, 'publish')
assert.ok([publishJob['needs']].flat().includes('verify'), 'the publish job must wait for the verify job')
assert.equal(publishJob['environment'], 'npm', 'the publish job must run in the protected npm environment')
assert.deepEqual(
  publishJob['permissions'],
  allowedJobPermissions.get(`${PUBLISH}#publish`),
  'the publish job must request its OIDC token'
)
const checkout = stepsOf(publish, 'verify').find(
  (step) => typeof step['uses'] === 'string' && step['uses'].startsWith('actions/checkout@')
)
assert.equal(
  object(checkout?.['with'], `${PUBLISH} verify checkout`)['fetch-depth'],
  0,
  'the release verify job must fetch full history for the main ancestry check'
)
const tagCheck = stepsOf(publish, 'verify').find((step) => isRecord(step['env']) && 'RELEASE_PRERELEASE' in step['env'])
assert.equal(
  object(tagCheck?.['env'], `${PUBLISH} release tag check env`)['RELEASE_PRERELEASE'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JavaScript template
  '${{ github.event.release.prerelease }}',
  'the release tag check must read the prerelease flag from the release event'
)
const verifyLines = runCommands(publish, 'verify')
for (const fragment of [
  'if [ "$RELEASE_PRERELEASE" != "false" ]; then',
  'if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then'
]) {
  assert.ok(verifyLines.includes(fragment), `the release verify job must run: ${fragment}`)
}
assertRuns(
  publish,
  'verify',
  [
    'npm run verify:commit',
    'npm run build',
    'npm run typecheck',
    'npm run test:coverage',
    'npm run audit:full',
    'npm run audit:runtime',
    'node scripts/package-smoke.mjs package'
  ],
  'the release verify job'
)
// biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder is bash interpolation inside the workflow, not a JavaScript template
const publishCommand = 'npm publish "./${packages[0]}" --provenance --access public'
assertRuns(publish, 'publish', ['packages=(package/*.tgz)', publishCommand], 'the publish job')
const publishLines = Object.keys(object(publish['jobs'], `${PUBLISH} jobs`)).flatMap((job) => runCommands(publish, job))
assert.equal(
  publishLines.filter((line) => /\bnpm publish\b/.test(line)).length,
  1,
  'publish workflow must have one npm publish command'
)
assert.ok(
  !publishLines.some((line) => /\bnpm pack\b/.test(line)),
  'publish workflow must pack only through package smoke'
)
// The publish job runs the npm that ships with its Node.js release. Installing another one would put
// an unlocked package on the path to the registry credential.
assert.ok(
  !publishLines.some((line) => /\bnpm (?:install|i) (?:--global|-g)\b/.test(line)),
  'publish workflow must not install npm ad hoc'
)

// The drift tracker writes to the repository's issues, so only main's own runs may open or close it.
// What it does with the issues it finds is covered by test/upstream-monitor-tracker.test.ts.
const track = jobOf(object(parsed.get(MONITOR), MONITOR), 'track')
assert.match(String(track['if']), /!cancelled\(\)/, 'the drift tracker must not report cancelled runs')
assert.match(String(track['if']), /github\.ref == 'refs\/heads\/main'/, 'the drift tracker must run only for main')

console.log('Workflow security and publication invariants verified.')
