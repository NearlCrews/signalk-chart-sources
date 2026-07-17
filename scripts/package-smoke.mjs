import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'signalk-chart-sources-pack-'))
const requestedDestination = process.argv[2]
const packDestination = requestedDestination === undefined ? temp : resolve(requestedDestination)
const consumer = join(temp, 'consumer')

try {
  mkdirSync(packDestination, { recursive: true })
  mkdirSync(consumer)
  const existingTarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(existingTarballs, [], `pack destination already contains tarballs: ${existingTarballs.join(', ')}`)

  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', packDestination], { encoding: 'utf8' })
  )
  assert.equal(packed.length, 1, `npm pack produced ${packed.length} reports`)
  const result = packed[0]
  assert.ok(result?.filename)
  const tarballs = readdirSync(packDestination).filter((name) => name.endsWith('.tgz'))
  assert.deepEqual(tarballs, [result.filename], `expected exactly one verified tarball, found: ${tarballs.join(', ')}`)

  const paths = result.files.map(({ path }) => path)
  assert.ok(paths.includes('dist/index.js'))
  assert.ok(paths.includes('dist/index.d.ts'))
  assert.ok(paths.includes('CHANGELOG.md'))
  assert.ok(paths.includes('MIGRATING.md'))
  assert.ok(
    paths.every((path) => /^(dist\/|package\.json$|README\.md$|CHANGELOG\.md$|MIGRATING\.md$|LICENSE$)/.test(path)),
    `unexpected packed files: ${paths.join(', ')}`
  )

  const tarball = join(packDestination, result.filename)
  execFileSync(join(process.cwd(), 'node_modules/.bin/publint'), ['run', tarball, '--strict'], {
    stdio: 'pipe'
  })

  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    stdio: 'pipe'
  })
  const installedPackage = JSON.parse(
    readFileSync(join(consumer, 'node_modules/signalk-chart-sources/package.json'), 'utf8')
  )
  assert.ok(installedPackage.exports?.['.']?.types)
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        "import { CHART_SOURCES, chartSourceById } from 'signalk-chart-sources'",
        "if (chartSourceById('depth-gebco')?.id !== 'depth-gebco') process.exit(1)",
        'if (!Object.isFrozen(CHART_SOURCES)) process.exit(1)'
      ].join(';')
    ],
    { cwd: consumer, stdio: 'pipe' }
  )
  writeFileSync(
    join(consumer, 'smoke.ts'),
    [
      "import { chartSourceById, tileCountInBbox, type LngLatBbox } from 'signalk-chart-sources'",
      'const bbox: LngLatBbox = [-1, -1, 1, 1]',
      "const source = chartSourceById('depth-gebco')",
      "if (!source) throw new Error('missing source')",
      'const count: number = tileCountInBbox(source, bbox, [0, 0])',
      'void count'
    ].join('\n')
  )
  execFileSync(
    join(process.cwd(), 'node_modules/.bin/tsc'),
    [
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      join(consumer, 'smoke.ts')
    ],
    { cwd: consumer, stdio: 'pipe' }
  )
  console.log(`package smoke passed for ${result.filename} with ${result.files.length} files`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
