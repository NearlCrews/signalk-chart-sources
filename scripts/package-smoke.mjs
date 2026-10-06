import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EXPECTED_EXPORTS } from './expected-exports.mjs'

const execFileAsync = promisify(execFile)

const temp = mkdtempSync(join(tmpdir(), 'signalk-chart-sources-pack-'))
const requestedDestination = process.argv[2]
const packDestination = requestedDestination === undefined ? temp : resolve(requestedDestination)
const consumer = join(temp, 'consumer')

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
 * The compilers a consumer realistically type-checks the declarations with. The default `tsc` bin
 * must stay TypeScript 7; TypeScript 6 is aliased as `typescript6` because both known consumers
 * still run TypeScript 6 tooling, and its own `tsc` bin loses the link to TypeScript 7's. Both bins
 * are Node.js scripts, run with this Node.js.
 */
const COMPILERS = [
  { label: 'TypeScript 7', bin: join(process.cwd(), 'node_modules/.bin/tsc'), version: /^Version 7\./ },
  { label: 'TypeScript 6', bin: join(process.cwd(), 'node_modules/typescript6/bin/tsc'), version: /^Version 6\./ }
]

/** Node-style resolution, and the bundler resolution Binnacle's Vite build uses. */
const RESOLUTIONS = [
  ['--module', 'NodeNext', '--moduleResolution', 'NodeNext'],
  ['--module', 'ESNext', '--moduleResolution', 'Bundler']
]

try {
  mkdirSync(packDestination, { recursive: true })
  mkdirSync(consumer)
  const existingTarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(existingTarballs, [], `pack destination already contains tarballs: ${existingTarballs.join(', ')}`)

  // Every caller builds first, and the tarball must reflect that exact dist, so no lifecycle script
  // may run. npm 10 still prints a lifecycle banner before the JSON report for a prepare script even
  // with scripts ignored, so slice from the array start rather than trusting the first byte.
  const packOutput = await run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packDestination])
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
  assert.ok(
    paths.every((path) => /^(dist\/|package\.json$|README\.md$|CHANGELOG\.md$|MIGRATING\.md$|LICENSE$)/.test(path)),
    `unexpected packed files: ${paths.join(', ')}`
  )

  const tarball = join(packDestination, result.filename)
  await run(join(process.cwd(), 'node_modules/.bin/publint'), ['run', tarball, '--strict'])

  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer })
  const installedPackage = JSON.parse(
    readFileSync(join(consumer, 'node_modules/signalk-chart-sources/package.json'), 'utf8')
  )
  assert.ok(installedPackage.exports?.['.']?.types)
  await run(
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
      '  webMercatorTileBounds',
      "} from 'signalk-chart-sources'",
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
      'void [mode, group, count, covered, meters, url, bytes, first]'
    ].join('\n')
  )
  // The consumer compatibility floor: the compilers and resolution modes a Node 22 or bundler
  // consumer compiles with, deliberately pinned rather than read from tsconfig.json so a library
  // target bump cannot raise the floor without this check flagging it. The compiles are independent,
  // so they run at once.
  /**
   * @param {{ bin: string }} compiler
   * @param {string[]} args
   */
  const tsc = (compiler, args) => run(process.execPath, [compiler.bin, ...args], { cwd: consumer })
  const versions = await Promise.all(
    COMPILERS.map(async (compiler) => {
      const version = (await tsc(compiler, ['--version'])).trim()
      assert.match(version, compiler.version, `${compiler.label} resolved to ${version}`)
      return version.replace(/^Version /, 'TypeScript ')
    })
  )
  await Promise.all(
    COMPILERS.flatMap((compiler) =>
      RESOLUTIONS.map((resolution) =>
        tsc(compiler, ['--noEmit', '--strict', '--target', 'ES2023', ...resolution, join(consumer, 'smoke.ts')])
      )
    )
  )
  console.log(
    `package smoke passed for ${result.filename}: ${result.files.length} files, ${EXPECTED_EXPORTS.length} ` +
      `exports, declarations checked with ${versions.join(' and ')} under NodeNext and Bundler resolution`
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
