import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { isScalar, parseDocument } from 'yaml'
import { isRecord, object, readManifest } from './records.mjs'

const CI = '.github/workflows/ci.yml'
const PUBLISH = '.github/workflows/npm-publish.yml'
const MONITOR = '.github/workflows/upstream-monitor.yml'
const SECURITY = '.github/workflows/workflow-security.yml'
const workflows = [CI, PUBLISH, MONITOR, SECURITY]
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
// Each reviewed action and its pinned commit. The release comment beside each pin is required below,
// and zizmor's online audit, which must stay on, confirms that release points at the pinned commit.
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
// The condition that limits a CI step to the one lane the matrix marks primary.
const PRIMARY_LANE = 'matrix.primary'
// The CI success gate's whole check: fail unless every build lane passed.
const GATE_CHECK = 'test "$BUILD_RESULT" = success'
// The publish job holds the OIDC token, so it runs exactly these reviewed lines and nothing else: a
// check that the bundled npm supports trusted publishing, then the publication of the one verified
// tarball. An exact list rather than a denylist, because npm alone has too many ways to install.
// The escaped \${ is bash interpolation inside the workflow.
const PUBLISH_JOB_COMMANDS = [
  "node -e '",
  'const [major, minor, patch] = process.argv[1].split(".").map(Number)',
  'const supported = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)))',
  'if (!supported) {',
  'console.error("npm " + process.argv[1] + " predates trusted publishing, which needs 11.5.1")',
  'process.exit(1)',
  '}',
  `' "$(npm --version)"`,
  'shopt -s nullglob',
  'packages=(package/*.tgz)',
  `if [ "\${#packages[@]}" -ne 1 ]; then`,
  `echo "Expected one verified tarball, found \${#packages[@]}" >&2`,
  'exit 1',
  'fi',
  `npm publish "./\${packages[0]}" --provenance --access public`
]

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
 * The action a `uses` value names and the ref it pins, split at the `@`.
 *
 * @param {string} uses
 * @returns {{ action: string, ref: string | undefined }}
 */
function parseUses(uses) {
  const [action = '', ref] = uses.split('@')
  return { action, ref }
}

/**
 * @param {Record<string, unknown>} step
 * @returns {Record<string, unknown>}
 */
function withOf(step) {
  return isRecord(step['with']) ? step['with'] : {}
}

/**
 * The first step of a job that uses the named action, at any ref.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @param {string} action
 * @returns {Record<string, unknown> | undefined}
 */
function stepUsing(workflow, job, action) {
  return stepsOf(workflow, job).find(
    (step) => typeof step['uses'] === 'string' && parseUses(step['uses']).action === action
  )
}

/**
 * A step's command lines, trimmed, without blank lines or shell comments. Parsed YAML carries no
 * comments either, so a note that mentions a command can neither satisfy nor trip a check.
 *
 * @param {Record<string, unknown>} step
 * @returns {string[]}
 */
function commandsOf(step) {
  return typeof step['run'] === 'string'
    ? step['run']
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'))
    : []
}

/** @type {WeakMap<Record<string, unknown>, Array<readonly [Record<string, unknown>, string[]]>>} */
const splitJobs = new WeakMap()

/**
 * Each of a job's steps beside its command lines, split once per job however many checks read them.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @returns {Array<readonly [Record<string, unknown>, string[]]>}
 */
function stepCommands(workflow, job) {
  const details = jobOf(workflow, job)
  let entries = splitJobs.get(details)
  if (entries === undefined) {
    entries = stepsOf(workflow, job).map((step) => /** @type {const} */ ([step, commandsOf(step)]))
    splitJobs.set(details, entries)
  }
  return entries
}

/**
 * Every command line a job's run steps execute.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @returns {string[]}
 */
function runCommands(workflow, job) {
  return stepCommands(workflow, job).flatMap(([, lines]) => lines)
}

/**
 * Require a step with a matching command line that runs unconditionally, or, when `condition` is given,
 * under exactly that condition, and return it. A command on a step gated by anything else may never
 * run at all.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @param {(line: string) => boolean} matches
 * @param {string} description
 * @param {string} label
 * @param {string} [condition]
 * @returns {Record<string, unknown>}
 */
function assertStepRuns(workflow, job, matches, description, label, condition) {
  const [step] = stepCommands(workflow, job).find(([, lines]) => lines.some(matches)) ?? []
  assert.ok(step, `${label} must run: ${description}`)
  assert.equal(
    step['if'],
    condition,
    `${label} must run ${description} ${condition === undefined ? 'unconditionally' : `only under ${condition}`}`
  )
  return step
}

/**
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @param {readonly string[]} commands
 * @param {string} label
 * @param {string} [condition]
 * @returns {Record<string, unknown>[]} the step running each command, in the order given
 */
function assertRuns(workflow, job, commands, label, condition) {
  return commands.map((command) => assertStepRuns(workflow, job, (line) => line === command, command, label, condition))
}

/**
 * Require the step running `later` to come after the step running `earlier` in the job.
 *
 * @param {Record<string, unknown>} workflow
 * @param {string} job
 * @param {Record<string, unknown>} earlier
 * @param {Record<string, unknown>} later
 * @param {string} message
 */
function assertOrdered(workflow, job, earlier, later, message) {
  const steps = stepsOf(workflow, job)
  assert.ok(steps.indexOf(earlier) < steps.indexOf(later), message)
}

/**
 * The release comment beside a `uses` value, which the plain parsed workflow drops.
 *
 * @param {ReturnType<typeof parseDocument>} document
 * @param {readonly (string | number)[]} path
 * @returns {string | undefined}
 */
function releaseComment(document, path) {
  const node = document.getIn(path, true)
  return isScalar(node) ? node.comment?.trim() : undefined
}

/** @type {Map<string, Record<string, unknown>>} */
const parsed = new Map()

// Everything below reads the parsed jobs and steps structurally rather than scanning raw text. A
// textual scan cannot tell a real step from a comment or an embedded script line that merely looks
// like one, and it has to guess where a step ends, which lets a later step's setting satisfy an
// earlier checkout that never had one.
for (const path of workflows) {
  const document = parseDocument(readFileSync(path, 'utf8'))
  // parseDocument collects syntax errors rather than throwing them.
  if (document.errors.length > 0) throw document.errors[0]
  const workflow = object(document.toJS(), path)
  parsed.set(path, workflow)
  const permissions = object(workflow['permissions'], `${path} permissions`)
  assert.deepEqual(permissions, { contents: 'read' }, `${path} must default to read-only contents`)
  const on = workflow['on']
  const triggers =
    typeof on === 'string' ? [on] : Array.isArray(on) ? on.map(String) : Object.keys(object(on, `${path} triggers`))
  for (const trigger of forbiddenTriggers) {
    assert.ok(!triggers.includes(trigger), `${path} must not use the ${trigger} trigger`)
  }

  for (const name of Object.keys(object(workflow['jobs'], `${path} jobs`))) {
    const details = jobOf(workflow, name)

    // A job or step allowed to fail reports success whatever happened, so it proves nothing.
    assert.ok(!('continue-on-error' in details), `${path} job ${name} must not continue on error`)
    // A hung job otherwise holds a runner for the six-hour default. A reusable workflow sets its own.
    if (details['uses'] === undefined) {
      assert.equal(typeof details['timeout-minutes'], 'number', `${path} job ${name} must set timeout-minutes`)
    }

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
    /** @type {Array<{ uses: string, comment: string | undefined }>} */
    const references =
      typeof details['uses'] === 'string'
        ? [{ uses: details['uses'], comment: releaseComment(document, ['jobs', name, 'uses']) }]
        : []
    for (const [index, step] of stepsOf(workflow, name).entries()) {
      assert.ok(!('continue-on-error' in step), `${path} job ${name} steps must not continue on error`)
      const uses = step['uses']
      if (typeof uses !== 'string') continue
      references.push({ uses, comment: releaseComment(document, ['jobs', name, 'steps', index, 'uses']) })
      const { action } = parseUses(uses)
      if (action === 'actions/checkout') {
        assert.equal(
          withOf(step)['persist-credentials'],
          false,
          `${path} job ${name} must disable checkout credentials`
        )
      }
      // A release build restores nothing from a cache that other workflow runs can write.
      if (path === PUBLISH && action === 'actions/setup-node') {
        assert.equal(withOf(step)['package-manager-cache'], false, `${path} job ${name} must disable the npm cache`)
        assert.equal(withOf(step)['cache'], undefined, `${path} job ${name} must not restore a cache`)
      }
    }

    for (const { uses, comment } of references) {
      if (uses.startsWith('./')) continue
      const { action, ref } = parseUses(uses)
      // Check the pin and the allowlist separately. Comparing only against the map lets an unpinned
      // reference to an unreviewed action pass, because both sides come back undefined.
      assert.match(ref ?? '', /^[0-9a-f]{40}$/, `${path} must pin ${action} to a full commit SHA`)
      assert.ok(expectedActions.has(action), `${path} uses an unreviewed action: ${action}`)
      assert.equal(ref, expectedActions.get(action), `${path} must use the reviewed ${action} SHA`)
      assert.match(comment ?? '', /^v\d+(?:\.\d+){0,2}$/, `${path} must name the release of its ${action} pin`)
    }
  }
}

const ci = object(parsed.get(CI), CI)
const ciBuild = jobOf(ci, 'build')
assert.equal(ciBuild['if'], undefined, 'the CI build job must run for every event')
const matrix = object(object(ciBuild['strategy'], `${CI} build strategy`)['matrix'], `${CI} build matrix`)
const lanes = matrix['include'] ?? []
assert.ok(Array.isArray(lanes), `${CI} matrix include must be a list`)
assert.equal(
  lanes.filter((lane) => object(lane, `${CI} matrix lane`)['primary'] === true).length,
  1,
  'CI must mark exactly one primary lane for the repository-wide checks'
)
// The engines floor is the oldest Node.js the package claims to support, so CI must test it.
const floor = /^>=\s*(\d+)/.exec(String(object(readManifest('.')['engines'], 'package.json engines')['node']))?.[1]
assert.ok(floor, 'package.json engines.node must declare a >= floor')
const nodeVersions = matrix['node-version']
assert.ok(
  Array.isArray(nodeVersions) && nodeVersions.includes(Number(floor)),
  `CI must test the engines.node floor, Node.js ${floor}`
)
// The smoke test packs the dist the Build step produced, so it runs after it rather than through
// npm run test:package, which would build the package a second time.
const [ciBuildStep, ciSmoke] = assertRuns(
  ci,
  'build',
  ['npm run build', 'node scripts/package-smoke.mjs', 'npm ci', 'npm run typecheck', 'npm run test:coverage'],
  'every CI lane'
)
assert.ok(ciBuildStep && ciSmoke)
assertOrdered(ci, 'build', ciBuildStep, ciSmoke, 'CI must build before it smoke-tests the packed package')
assertRuns(
  ci,
  'build',
  ['npm run verify:commit', 'npm run audit:full', 'npm run audit:runtime'],
  'the primary CI lane',
  PRIMARY_LANE
)
assertStepRuns(
  ci,
  'build',
  (line) => line.startsWith('git diff --check'),
  'a whitespace check of the actual commit or pull-request diff',
  'the primary CI lane',
  PRIMARY_LANE
)
// The gate is the required status check. A skipped job counts as passing there, so it must run even
// when a lane fails, and must fail unless every lane passed.
const gate = jobOf(ci, 'ci-success')
assert.equal(gate['name'], 'CI success', 'CI must expose the stable CI success gate')
assert.deepEqual([gate['needs']].flat(), ['build'], 'the CI success gate must wait for every build lane')
assert.match(String(gate['if']), /\balways\(\)/, 'the CI success gate must run when a lane fails')
const [gateStep] = assertRuns(ci, 'ci-success', [GATE_CHECK], 'the CI success gate')
assert.equal(
  object(gateStep?.['env'], 'CI success gate env')['BUILD_RESULT'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JavaScript template
  '${{ needs.build.result }}',
  'the CI success gate must read the build result'
)

const publish = object(parsed.get(PUBLISH), PUBLISH)
// Publishing the GitHub release is the first approval, so nothing else may start a publication.
assert.deepEqual(
  publish['on'],
  { release: { types: ['published'] } },
  'only a published release may start npm publication'
)
assert.equal(
  object(publish['concurrency'], `${PUBLISH} concurrency`)['cancel-in-progress'],
  false,
  'a release publication must never be cancelled part way'
)
for (const job of ['verify', 'publish']) {
  assert.equal(jobOf(publish, job)['if'], undefined, `the release ${job} job must not be conditional`)
}
const publishJob = jobOf(publish, 'publish')
assert.ok([publishJob['needs']].flat().includes('verify'), 'the publish job must wait for the verify job')
assert.equal(publishJob['environment'], 'npm', 'the publish job must run in the protected npm environment')
assert.deepEqual(
  publishJob['permissions'],
  allowedJobPermissions.get(`${PUBLISH}#publish`),
  'the publish job must request its OIDC token'
)
const checkout = stepUsing(publish, 'verify', 'actions/checkout')
assert.ok(checkout, 'the release verify job must check out the release')
assert.equal(
  withOf(checkout)['fetch-depth'],
  0,
  'the release verify job must fetch full history for the main ancestry check'
)
const [tagCheck] = assertRuns(
  publish,
  'verify',
  [
    'if [ "$RELEASE_PRERELEASE" != "false" ]; then',
    'if ! git merge-base --is-ancestor "$GITHUB_SHA" origin/main; then'
  ],
  'the release verify job'
)
const [verifyBuild, verifySmoke] = assertRuns(
  publish,
  'verify',
  [
    'npm run build',
    'node scripts/package-smoke.mjs package',
    'npm ci',
    'npm run verify:commit',
    'npm run typecheck',
    'npm run test:coverage',
    'npm run audit:full',
    'npm run audit:runtime'
  ],
  'the release verify job'
)
assert.ok(tagCheck && verifyBuild && verifySmoke)
assert.equal(
  object(tagCheck['env'], `${PUBLISH} release tag check env`)['RELEASE_PRERELEASE'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, not a JavaScript template
  '${{ github.event.release.prerelease }}',
  'the release tag check must read the prerelease flag from the release event'
)
assertOrdered(publish, 'verify', verifyBuild, verifySmoke, 'the release verify job must build before it packs')
// The verify job packs the tarball that gets published, so it packs with the npm bundled with its
// Node.js release. Installing another one would put an unlocked package into the release artifact.
assert.ok(
  !runCommands(publish, 'verify').some((line) =>
    /\bnpm\b.*\s(?:-g|--global|--location[= ]global)\b|\bcorepack\b/.test(line)
  ),
  'the release verify job must not install npm ad hoc'
)
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
// The publish job checks out nothing and installs nothing: it downloads the verified tarball and
// runs exactly the reviewed commands above, none of them skipped.
for (const step of stepsOf(publish, 'publish')) {
  assert.equal(step['if'], undefined, 'every publish job step must run unconditionally')
  if (typeof step['uses'] !== 'string') continue
  const { action } = parseUses(step['uses'])
  assert.ok(
    action === 'actions/setup-node' || action === 'actions/download-artifact',
    `the publish job must not use ${action}`
  )
}
assert.deepEqual(
  runCommands(publish, 'publish'),
  PUBLISH_JOB_COMMANDS,
  'the publish job must run exactly its reviewed commands'
)

// The drift tracker writes to the repository's issues, so only main's own runs may open or close it.
// What it does with the issues it finds is covered by test/upstream-monitor-tracker.test.ts.
const track = jobOf(object(parsed.get(MONITOR), MONITOR), 'track')
assert.match(String(track['if']), /!cancelled\(\)/, 'the drift tracker must not report cancelled runs')
assert.match(String(track['if']), /github\.ref == 'refs\/heads\/main'/, 'the drift tracker must run only for main')

// zizmor's online audits are the ones that tie each pinned commit to its action and its release comment.
const zizmor = stepUsing(object(parsed.get(SECURITY), SECURITY), 'zizmor', 'zizmorcore/zizmor-action')
assert.ok(zizmor, 'the workflow security check must run zizmor')
assert.equal(withOf(zizmor)['online-audits'], undefined, 'zizmor must keep its online audits')

console.log('Workflow security and publication invariants verified.')
