import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'signalk-chart-sources-pack-'))

try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { encoding: 'utf8' }))
  const result = packed[0]
  assert.ok(result?.filename)
  const paths = result.files.map(({ path }) => path)
  assert.ok(paths.includes('dist/index.js'))
  assert.ok(paths.includes('dist/index.d.ts'))
  assert.ok(paths.includes('MIGRATING.md'))
  assert.ok(paths.every((path) => /^(dist\/|package\.json$|README\.md$|MIGRATING\.md$|LICENSE$)/.test(path)), `unexpected packed files: ${paths.join(', ')}`)

  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, result.filename)], {
    cwd: temp,
    stdio: 'pipe'
  })
  const installedPackage = JSON.parse(readFileSync(join(temp, 'node_modules/signalk-chart-sources/package.json'), 'utf8'))
  assert.ok(installedPackage.exports?.['.']?.types)
  execFileSync(process.execPath, ['--input-type=module', '-e', [
    "import { CHART_SOURCES, chartSourceById } from 'signalk-chart-sources'",
    "if (chartSourceById('depth-gebco')?.id !== 'depth-gebco') process.exit(1)",
    'if (!Object.isFrozen(CHART_SOURCES)) process.exit(1)'
  ].join(';')], { cwd: temp, stdio: 'pipe' })
  writeFileSync(join(temp, 'smoke.ts'), [
    "import { chartSourceById, tileCountInBbox, type LngLatBbox } from 'signalk-chart-sources'",
    'const bbox: LngLatBbox = [-1, -1, 1, 1]',
    "const source = chartSourceById('depth-gebco')",
    "if (!source) throw new Error('missing source')",
    'const count: number = tileCountInBbox(source, bbox, [0, 0])',
    'void count'
  ].join('\n'))
  execFileSync(join(process.cwd(), 'node_modules/.bin/tsc'), [
    '--noEmit', '--strict', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', join(temp, 'smoke.ts')
  ], { cwd: temp, stdio: 'pipe' })
  console.log(`package smoke passed for ${result.filename} with ${result.files.length} files`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
