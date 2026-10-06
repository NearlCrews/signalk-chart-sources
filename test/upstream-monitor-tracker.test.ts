import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parse } from 'yaml'
import { object } from '../scripts/records.mjs'

// The drift tracker is the github-script body of the upstream monitor's track job. It runs here as the
// action runs it, an async function body, against stub github, context, core, and process objects.
const workflow = object(
  parse(readFileSync(new URL('../.github/workflows/upstream-monitor.yml', import.meta.url), 'utf8')),
  'upstream monitor workflow'
)
const steps = object(object(workflow['jobs'], 'upstream monitor jobs')['track'], 'track job')['steps']
assert.ok(Array.isArray(steps) && steps.length === 1, 'the track job must have exactly one step')
const script = object(object(steps[0], 'track step')['with'], 'track step inputs')['script']
assert.ok(typeof script === 'string', 'the track step must carry an inline script')

type Tracker = (github: unknown, context: unknown, core: unknown, process: unknown) => Promise<void>
const AsyncFunction = (async () => {}).constructor as new (...parameters: string[]) => Tracker
const tracker = new AsyncFunction('github', 'context', 'core', 'process', script)

interface Author {
  readonly login: string
}
interface Issue {
  readonly number: number
  readonly title: string
  readonly user: Author
  readonly body?: string
  readonly pull_request?: object
}
interface Comment {
  readonly user: Author
  readonly body: string
}
type Call =
  | { readonly kind: 'create'; readonly title: string; readonly body: string }
  | { readonly kind: 'comment'; readonly issue: number; readonly body: string }
  | { readonly kind: 'update'; readonly issue: number; readonly state: string }
  | { readonly kind: 'info'; readonly message: string }

const TITLE = 'Upstream monitor failure'
const MARKER = '<!-- upstream-monitor-report -->'
const RUN_URL = 'https://github.com/NearlCrews/signalk-chart-sources/actions/runs/42'
const BOT: Author = { login: 'github-actions[bot]' }
const OUTSIDER: Author = { login: 'mallory' }
/** Reports as check-upstreams.ts writes them to its step output: already fenced. */
const REPORT = '```text\nGEBCO attribution: drifted\n```'
const NEW_REPORT = '```text\ndepth-emodnet: fullExtent drifted\n```'
const NO_CHECKS = 'The run recorded no check failures, so it most likely failed before the checks ran.'

function bodyFor(details: string): string {
  return `The scheduled upstream monitor failed in ${RUN_URL}.\n\n${details}\n\n${MARKER}`
}

async function runTracker(options: {
  readonly result: 'success' | 'failure'
  readonly report?: string
  readonly issues?: readonly Issue[]
  readonly comments?: Readonly<Record<number, readonly Comment[]>>
}): Promise<Call[]> {
  const calls: Call[] = []
  const repo = { owner: 'NearlCrews', repo: 'signalk-chart-sources' }
  const github = {
    paginate: async <P, T>(method: (params: P) => T, params: P): Promise<T> => method(params),
    rest: {
      issues: {
        listForRepo: (params: { readonly state: string }) => {
          assert.equal(params.state, 'open')
          return options.issues ?? []
        },
        listComments: (params: { readonly issue_number: number }) => options.comments?.[params.issue_number] ?? [],
        create: async (params: { readonly title: string; readonly body: string }) => {
          calls.push({ kind: 'create', title: params.title, body: params.body })
        },
        createComment: async (params: { readonly issue_number: number; readonly body: string }) => {
          calls.push({ kind: 'comment', issue: params.issue_number, body: params.body })
        },
        update: async (params: { readonly issue_number: number; readonly state: string }) => {
          calls.push({ kind: 'update', issue: params.issue_number, state: params.state })
        }
      }
    }
  }
  const context = { serverUrl: 'https://github.com', repo, runId: 42 }
  const core = { info: (message: string) => calls.push({ kind: 'info', message }) }
  const env = { CHECK_RESULT: options.result, REPORT: options.report ?? '' }
  await tracker(github, context, core, { env })
  return calls
}

test('a failure with no tracking issue opens one carrying the fenced report', async () => {
  assert.deepEqual(await runTracker({ result: 'failure', report: REPORT }), [
    { kind: 'create', title: TITLE, body: bodyFor(REPORT) }
  ])
})

test('a run that failed before its checks says so, and says it again on the next run', async () => {
  assert.deepEqual(await runTracker({ result: 'failure' }), [
    { kind: 'create', title: TITLE, body: bodyFor(NO_CHECKS) }
  ])
  const issues = [{ number: 18, title: TITLE, user: BOT, body: bodyFor(NO_CHECKS) }]
  assert.deepEqual(await runTracker({ result: 'failure', issues }), [
    { kind: 'comment', issue: 18, body: bodyFor(NO_CHECKS) }
  ])
})

test('an unchanged report is not posted again', async () => {
  const unchanged = [{ kind: 'info', message: 'The failures match the last report on #18; not commenting.' }]
  // Matched in the issue body, including one an edit in the web UI saved with CRLF line endings.
  for (const body of [bodyFor(REPORT), bodyFor(REPORT).replaceAll('\n', '\r\n')]) {
    const issues = [{ number: 18, title: TITLE, user: BOT, body }]
    assert.deepEqual(await runTracker({ result: 'failure', report: REPORT, issues }), unchanged)
  }
  // Matched in the latest workflow comment, after an older report in the issue body.
  const issues = [{ number: 18, title: TITLE, user: BOT, body: bodyFor(NEW_REPORT) }]
  const comments = { 18: [{ user: BOT, body: bodyFor(REPORT) }] }
  assert.deepEqual(await runTracker({ result: 'failure', report: REPORT, issues, comments }), unchanged)
})

test('a changed report is commented on the existing tracking issue', async () => {
  const issues = [{ number: 18, title: TITLE, user: BOT, body: bodyFor(REPORT) }]
  assert.deepEqual(await runTracker({ result: 'failure', report: NEW_REPORT, issues }), [
    { kind: 'comment', issue: 18, body: bodyFor(NEW_REPORT) }
  ])
})

test("an outsider's look-alike issue is ignored", async () => {
  const lookAlike = { number: 99, title: TITLE, user: OUTSIDER, body: bodyFor(REPORT) }
  assert.deepEqual(await runTracker({ result: 'failure', report: REPORT, issues: [lookAlike] }), [
    { kind: 'create', title: TITLE, body: bodyFor(REPORT) }
  ])
  const issues = [lookAlike, { number: 18, title: TITLE, user: BOT, body: bodyFor(REPORT) }]
  assert.deepEqual(await runTracker({ result: 'failure', report: NEW_REPORT, issues }), [
    { kind: 'comment', issue: 18, body: bodyFor(NEW_REPORT) }
  ])
})

test("an outsider's comment copying the report cannot suppress it", async () => {
  const issues = [{ number: 18, title: TITLE, user: BOT, body: bodyFor(REPORT) }]
  const comments = { 18: [{ user: OUTSIDER, body: bodyFor(NEW_REPORT) }] }
  assert.deepEqual(await runTracker({ result: 'failure', report: NEW_REPORT, issues, comments }), [
    { kind: 'comment', issue: 18, body: bodyFor(NEW_REPORT) }
  ])
})

test('a passing run closes only the workflow-owned tracking issue', async () => {
  const lookAlike = { number: 99, title: TITLE, user: OUTSIDER, body: bodyFor(REPORT) }
  const owned = { number: 18, title: TITLE, user: BOT, body: bodyFor(REPORT) }
  assert.deepEqual(await runTracker({ result: 'success', issues: [lookAlike, owned] }), [
    { kind: 'comment', issue: 18, body: `Upstream checks passed in ${RUN_URL}. Closing until the next drift.` },
    { kind: 'update', issue: 18, state: 'closed' }
  ])
  assert.deepEqual(await runTracker({ result: 'success', issues: [lookAlike] }), [])
  assert.deepEqual(await runTracker({ result: 'success' }), [])
})

test('pull requests are never taken for the tracking issue', async () => {
  const pullRequest = { number: 5, title: TITLE, user: BOT, body: bodyFor(REPORT), pull_request: {} }
  assert.deepEqual(await runTracker({ result: 'failure', report: REPORT, issues: [pullRequest] }), [
    { kind: 'create', title: TITLE, body: bodyFor(REPORT) }
  ])
  assert.deepEqual(await runTracker({ result: 'success', issues: [pullRequest] }), [])
})
