import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { EXPECTED_EXPORTS } from './expected-exports.mjs'

const temp = mkdtempSync(join(tmpdir(), 'signalk-chart-sources-pack-'))
const requestedDestination = process.argv[2]
const packDestination = requestedDestination === undefined ? temp : resolve(requestedDestination)
const consumer = join(temp, 'consumer')

/**
 * Run a child quietly but report it loudly. A bare execFileSync failure prints only "Command
 * failed" and leaves the actual diagnostic buffered on the error object as raw Buffers.
 */
function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options })
  } catch (error) {
    const detail = [error.stdout, error.stderr]
      .map((part) => String(part ?? '').trim())
      .filter(Boolean)
      .join('\n')
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`, { cause: error })
  }
}

try {
  mkdirSync(packDestination, { recursive: true })
  mkdirSync(consumer)
  const existingTarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(existingTarballs, [], `pack destination already contains tarballs: ${existingTarballs.join(', ')}`)

  // npm can print lifecycle banners before the JSON report, so slice from the array start.
  const packOutput = run('npm', ['pack', '--json', '--pack-destination', packDestination])
  const reportStart = packOutput.indexOf('[')
  assert.ok(reportStart >= 0, `npm pack produced no JSON report: ${packOutput}`)
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
  run(join(process.cwd(), 'node_modules/.bin/publint'), ['run', tarball, '--strict'])

  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: consumer })
  const installedPackage = JSON.parse(
    readFileSync(join(consumer, 'node_modules/signalk-chart-sources/package.json'), 'utf8')
  )
  assert.ok(installedPackage.exports?.['.']?.types)
  run(
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
      '  estimateBytes,',
      '  expandUpstreamUrl,',
      '  iterateTilesInBbox,',
      '  tileCountInBbox,',
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
      'const count: number = tileCountInBbox(source, bbox, zooms)',
      'const meters: MercatorBbox = webMercatorTileBounds(0, 0, 0)',
      'const url: string = expandUpstreamUrl(source, 0, 0, 0)',
      'const bytes: number = estimateBytes([source.id], bbox, zooms, {})',
      'const first: ZXY | undefined = [...iterateTilesInBbox(source, bbox, zooms, options)][0]',
      'void [mode, count, meters, url, bytes, first]'
    ].join('\n')
  )
  run(
    join(process.cwd(), 'node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--strict',
      '--target',
      'ES2023',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      join(consumer, 'smoke.ts')
    ],
    { cwd: consumer }
  )
  console.log(
    `package smoke passed for ${result.filename}: ${result.files.length} files, ${EXPECTED_EXPORTS.length} exports`
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
