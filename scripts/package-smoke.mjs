import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EXPECTED_EXPORTS } from './expected-exports.mjs'
import { isRecord, object, readManifest } from './records.mjs'

const execFileAsync = promisify(execFile)

/**
 * Run a child quietly but report it loudly. A bare execFile failure prints only "Command failed" and
 * leaves the actual diagnostic buffered on the error object.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<string>}
 */
async function run(command, args, options = {}) {
  try {
    return (await execFileAsync(command, args, { encoding: 'utf8', ...options })).stdout
  } catch (error) {
    const output = /** @type {{ stdout?: unknown, stderr?: unknown }} */ (error)
    const detail = [output.stdout, output.stderr]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`, { cause: error })
  }
}

/**
 * Wait for every one of a set of independent steps, then fail with the first failure. Promise.all
 * rejects while the others are still running, and the cleanup below would then remove the consumer
 * directory from under them.
 *
 * @param {readonly Promise<unknown>[]} steps
 */
async function settled(steps) {
  for (const result of await Promise.allSettled(steps)) {
    if (result.status === 'rejected') throw result.reason
  }
}

/**
 * The JavaScript entry point of an installed package's bin, run with this Node.js. The shims under
 * node_modules/.bin are shell and batch scripts on Windows, which execFile cannot start and Node.js
 * cannot load, and which link to whichever package claims the name first.
 *
 * @param {string} name
 * @param {string} command
 * @returns {string}
 */
function binOf(name, command) {
  const root = join(process.cwd(), 'node_modules', name)
  const bin = readManifest(root)['bin']
  const entry = typeof bin === 'string' ? bin : isRecord(bin) ? bin[command] : undefined
  assert.ok(typeof entry === 'string', `${name} declares no ${command} bin`)
  return join(root, entry)
}

/**
 * The npm CLI script to run with this Node.js, or undefined to run the npm on the path. `npm run`
 * names its own CLI in npm_execpath. Run directly on Windows, where the npm on the path is a batch
 * file execFile cannot start, the script is the one Node.js installs beside its own binary.
 */
const NPM_CLI = (() => {
  const named = process.env['npm_execpath']
  if (named !== undefined && basename(named) === 'npm-cli.js') return named
  return process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : undefined
})()

/**
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 */
function npm(args, options = {}) {
  return NPM_CLI === undefined ? run('npm', args, options) : run(process.execPath, [NPM_CLI, ...args], options)
}

/**
 * The compilers a consumer realistically type-checks the declarations with. TypeScript 6 is aliased
 * as `typescript6` because both known consumers still run TypeScript 6 tooling.
 */
const COMPILERS = [
  { label: 'TypeScript 7', bin: binOf('typescript', 'tsc'), version: /^Version 7\./ },
  { label: 'TypeScript 6', bin: binOf('typescript6', 'tsc'), version: /^Version 6\./ }
]

/** Node-style resolution, and the bundler resolution Binnacle's Vite build uses. */
const RESOLUTIONS = [
  ['--module', 'NodeNext', '--moduleResolution', 'NodeNext'],
  ['--module', 'ESNext', '--moduleResolution', 'Bundler']
]

/** Lifecycle scripts npm would run inside a consumer's install of the package. */
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare']

// Created only once the bins above resolved, so a missing compiler cannot leave the directory behind.
const temp = mkdtempSync(join(tmpdir(), 'signalk-chart-sources-pack-'))
const requestedDestination = process.argv[2]
const packDestination = requestedDestination === undefined ? temp : resolve(requestedDestination)
const consumer = join(temp, 'consumer')

try {
  mkdirSync(packDestination, { recursive: true })
  mkdirSync(consumer)
  const existingTarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(existingTarballs, [], `pack destination already contains tarballs: ${existingTarballs.join(', ')}`)

  // Every caller builds first, and the tarball must reflect that exact dist, so no lifecycle script
  // may run. npm 10 still prints a lifecycle banner before the JSON report for a prepare script even
  // with scripts ignored, so slice from the array start rather than trusting the first byte.
  const packOutput = await npm(['pack', '--json', '--ignore-scripts', '--pack-destination', packDestination])
  const reportStart = packOutput.indexOf('[')
  assert.ok(reportStart >= 0, `npm pack produced no JSON report: ${packOutput}`)
  /** @type {Array<{ filename: string, files: Array<{ path: string }> }>} */
  const packed = JSON.parse(packOutput.slice(reportStart))
  assert.equal(packed.length, 1, `npm pack produced ${packed.length} reports`)
  const result = packed[0]
  assert.ok(result?.filename)
  const tarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(tarballs, [result.filename], `expected exactly one verified tarball, found: ${tarballs.join(', ')}`)

  const paths = result.files.map(({ path }) => path)
  // The release checklist requires every one of these in the published tarball.
  for (const required of [
    'dist/index.js',
    'dist/index.d.ts',
    'package.json',
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'MIGRATING.md'
  ]) {
    assert.ok(paths.includes(required), `packed tarball is missing ${required}`)
  }
  // dist holds compiled modules and their declarations only, so a stray source map, build cache, or
  // test file in it fails here rather than shipping.
  assert.ok(
    paths.every((path) =>
      /^(dist\/.+\.(?:js|d\.ts)$|package\.json$|README\.md$|CHANGELOG\.md$|MIGRATING\.md$|LICENSE$)/.test(path)
    ),
    `unexpected packed files: ${paths.join(', ')}`
  )

  const tarball = join(packDestination, result.filename)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  // Publint reads the tarball and the consumer installs it, so the two run at once.
  await settled([
    run(process.execPath, [binOf('publint', 'publint'), 'run', tarball, '--strict']),
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer })
  ])
  const installedPackage = readManifest(join(consumer, 'node_modules', 'signalk-chart-sources'))
  const rootExport = object(object(installedPackage['exports'], 'packed exports')['.'], 'packed root export')
  assert.equal(typeof rootExport['types'], 'string', 'the packed root export must name its declarations')
  // A consumer's install runs these unless it opts out, and a dependency-free library has no reason to.
  const scripts = isRecord(installedPackage['scripts']) ? installedPackage['scripts'] : {}
  const installScripts = INSTALL_SCRIPTS.filter((name) => scripts[name] !== undefined)
  assert.deepEqual(
    installScripts,
    [],
    `packed package.json declares install-time scripts: ${installScripts.join(', ')}`
  )
  const runtimeCheck = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import * as api from 'signalk-chart-sources'",
        `const expected = ${JSON.stringify(EXPECTED_EXPORTS)}`,
        'const actual = Object.keys(api).sort()',
        'const missing = expected.filter((name) => !actual.includes(name))',
        'const extra = actual.filter((name) => !expected.includes(name))',
        'if (missing.length || extra.length) {',
        "  throw new Error('export surface drifted; missing: ' + missing + '; unexpected: ' + extra)",
        '}',
        "const gebco = api.chartSourceById('depth-gebco')",
        "if (gebco?.id !== 'depth-gebco') throw new Error('catalog lookup failed')",
        "if (!Object.isFrozen(api.CHART_SOURCES)) throw new Error('catalog is not frozen')",
        "if (!api.expandUpstreamUrl(gebco, 0, 0, 0).startsWith('https://')) throw new Error('expand failed')",
        "if (!(api.estimateBytes(['depth-gebco'], [-1, -1, 1, 1], [0, 2], {}) > 0)) throw new Error('estimate failed')",
        "if (api.proxyTileTemplate('/p', 'depth-gebco') !== '/p/tile/depth-gebco/{z}/{x}/{y}') {",
        "  throw new Error('proxy template failed')",
        '}'
      ].join('\n')
    ],
    { cwd: consumer }
  )
  writeFileSync(
    join(consumer, 'smoke.ts'),
    [
      "import * as api from 'signalk-chart-sources'",
      'import {',
      '  chartSourceById,',
      '  coversBbox,',
      '  estimateBytes,',
      '  expandUpstreamUrl,',
      '  iterateTilesInBbox,',
      '  tileCountInBbox,',
      '  type ChartGroup,',
      '  type ChartSource,',
      '  type LngLatBbox,',
      '  type MercatorBbox,',
      '  type TileEnumerationOptions,',
      '  type UpstreamTemplate,',
      '  type ZXY,',
      '  type ZoomRange,',
      '  validateChartSource,',
      '  webMercatorTileBounds',
      "} from 'signalk-chart-sources'",
      // The declarations must name exactly the runtime exports: a missing name or an extra one fails
      // this object literal, so a value the JavaScript ships cannot go undeclared or the reverse.
      `const declared: { readonly [K in keyof typeof api]: true } = { ${EXPECTED_EXPORTS.map((name) => `${name}: true`).join(', ')} }`,
      'const bbox: LngLatBbox = [-1, -1, 1, 1]',
      'const zooms: ZoomRange = [0, 2]',
      'const options: TileEnumerationOptions = { maxTiles: 64 }',
      "const source: ChartSource | undefined = chartSourceById('depth-gebco')",
      "if (!source) throw new Error('missing source')",
      "const mode: UpstreamTemplate['mode'] = source.upstream.mode",
      'const group: ChartGroup | undefined = source.group',
      'const count: number = tileCountInBbox(source, bbox, zooms)',
      'const covered: boolean = coversBbox(source, bbox, zooms)',
      'const meters: MercatorBbox = webMercatorTileBounds(0, 0, 0)',
      'const url: string = expandUpstreamUrl(source, 0, 0, 0)',
      'const bytes: number = estimateBytes([source.id], bbox, zooms, {})',
      'const first: ZXY | undefined = [...iterateTilesInBbox(source, bbox, zooms, options)][0]',
      // validateChartSource is an assertion function, so a successful call narrows unknown input.
      'const candidate: unknown = JSON.parse(JSON.stringify(source))',
      'validateChartSource(candidate)',
      'const validated: ChartSource = candidate',
      'void [declared, mode, group, count, covered, meters, url, bytes, first, validated]'
    ].join('\n')
  )
  // The consumer compatibility floor: the compilers and resolution modes a Node 22 or bundler
  // consumer compiles with, deliberately pinned rather than read from tsconfig.json so a library
  // target bump cannot raise the floor without this check flagging it. The version probes, the
  // compiles, and the runtime check above are independent, so they all run at once.
  /**
   * @param {{ bin: string }} compiler
   * @param {string[]} args
   */
  const tsc = (compiler, args) => run(process.execPath, [compiler.bin, ...args], { cwd: consumer })
  const probes = COMPILERS.map(async (compiler) => {
    const version = (await tsc(compiler, ['--version'])).trim()
    assert.match(version, compiler.version, `${compiler.label} resolved to ${version}`)
    return version.replace(/^Version /, 'TypeScript ')
  })
  const compiles = COMPILERS.flatMap((compiler) =>
    RESOLUTIONS.map((resolution) =>
      tsc(compiler, ['--noEmit', '--strict', '--target', 'ES2023', ...resolution, join(consumer, 'smoke.ts')])
    )
  )
  await settled([runtimeCheck, ...probes, ...compiles])
  const versions = await Promise.all(probes)
  console.log(
    `package smoke passed for ${result.filename}: ${result.files.length} files, ${EXPECTED_EXPORTS.length} ` +
      `exports, declarations checked with ${versions.join(' and ')} under NodeNext and Bundler resolution`
  )
} finally {
  // Windows can briefly hold a handle on a file a child process just closed.
  rmSync(temp, { recursive: true, force: true, maxRetries: 3 })
}
