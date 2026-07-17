import assert from 'node:assert/strict'
import test from 'node:test'
import { validateChartSource } from '../src/validate.js'
import { makeSource } from './fixtures.js'

test('validateChartSource accepts a complete source', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource()))
})

test('validateChartSource narrows an unknown source after complete runtime validation', () => {
  const source: unknown = makeSource()
  validateChartSource(source)
  assert.equal(source.id, 's')
})

test('validateChartSource rejects invalid ids, zooms, coverage, estimates, and templates', () => {
  assert.throws(() => validateChartSource(makeSource({ id: '../x' })), /invalid source id/)
  assert.throws(() => validateChartSource(makeSource({ minzoom: 4, maxzoom: 3 })), /minzoom exceeds/)
  assert.throws(() => validateChartSource(makeSource({ coverage: [] })), /coverage must contain/)
  assert.throws(() => validateChartSource(makeSource({ bounds: [180, -1, -180, 1] })), /non-zero area/)
  assert.throws(() => validateChartSource(makeSource({ fallbackTileBytes: -1 })), /positive safe integer/)
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}.png' }
        })
      ),
    /missing \{y\}/
  )
})

test('validateChartSource rejects malformed runtime shapes and unknown modes', () => {
  assert.throws(() => validateChartSource(null), /must be an object/)
  assert.throws(() => validateChartSource({ ...makeSource(), id: 123 }), /invalid source id/)
  assert.throws(() => validateChartSource({ ...makeSource(), upstream: { mode: 'bogus' } }), /unknown upstream mode/)
  assert.throws(() => validateChartSource({ ...makeSource(), group: { id: '', title: '' } }), /group id/)
  const sparseCoverage = Array<readonly [number, number, number, number]>(1)
  assert.throws(() => validateChartSource({ ...makeSource(), coverage: sparseCoverage }), /coverage must contain/)
})

test('validateChartSource checks URL safety and every WMS runtime field', () => {
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'xyz', urlTemplate: 'https://user:secret@h/{z}/{x}/{y}.png' }
        })
      ),
    /must not include credentials/
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}/{date}.png' }
        })
      ),
    /unsupported template token/
  )

  const wms = {
    mode: 'wms',
    base: 'https://h/wms',
    layers: 'layer',
    styles: '',
    version: '1.3.0',
    format: 'image/png',
    transparent: true
  } as const
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, base: 'https://h/wms?token=x' } }),
    /query parameters/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, layers: 'layer&STYLES=evil' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, styles: 'ok#fragment' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, format: 'image/png\nX-Evil: yes' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, version: '1.1.1' } }),
    /version must be 1.3.0/
  )
  assert.throws(() => validateChartSource({ ...makeSource(), upstream: { ...wms, format: '' } }), /between 1 and/)
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, transparent: 'yes' } }),
    /must be boolean/
  )
})

test('validateChartSource checks style host shape and authorization case-insensitively', () => {
  assert.doesNotThrow(() =>
    validateChartSource(
      makeSource({
        upstream: { mode: 'style', styleUrl: 'https://tiles.example/style.json', allowedHosts: ['TILES.EXAMPLE'] }
      })
    )
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'style', styleUrl: 'https://tiles.example/style.json', allowedHosts: ['other.example'] }
        })
      ),
    /must include tiles.example/
  )
  assert.throws(
    () =>
      validateChartSource({
        ...makeSource(),
        upstream: { mode: 'style', styleUrl: 'https://tiles.example/style.json', allowedHosts: 'tiles.example' }
      }),
    /allowedHosts must contain/
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: {
            mode: 'style',
            styleUrl: 'https://tiles.example/style.json',
            allowedHosts: ['tiles.example', 'tiles.example']
          }
        })
      ),
    /must not contain duplicates/
  )
})
