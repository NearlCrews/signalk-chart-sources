import assert from 'node:assert/strict'
import test from 'node:test'
import { validateChartSource } from '../src/validate.js'
import { makeSource } from './fixtures.js'

/** A minimal valid WMS upstream. Hoisted so a change to the shape lands in one place. */
const wmsUpstream = {
  mode: 'wms',
  base: 'https://h/wms',
  layers: 'layer',
  styles: '',
  version: '1.3.0',
  format: 'image/png',
  transparent: true
} as const

test('validateChartSource accepts a complete source', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource()))
})

test('validateChartSource narrows an unknown source after complete runtime validation', () => {
  const source: unknown = makeSource()
  validateChartSource(source)
  assert.equal(source.id, 's')
})

test('validateChartSource rejects invalid ids, zooms, coverage, estimates, and templates', () => {
  assert.throws(() => validateChartSource(makeSource({ id: '../x' })), {
    name: 'TypeError',
    message: /invalid source id/
  })
  assert.throws(() => validateChartSource(makeSource({ minzoom: 4, maxzoom: 3 })), {
    name: 'RangeError',
    message: /minzoom exceeds/
  })
  assert.throws(() => validateChartSource(makeSource({ coverage: [] })), {
    name: 'RangeError',
    message: /coverage must contain/
  })
  assert.throws(() => validateChartSource(makeSource({ bounds: [180, -1, -180, 1] })), {
    name: 'RangeError',
    message: /non-zero area/
  })
  assert.throws(() => validateChartSource(makeSource({ fallbackTileBytes: -1 })), {
    name: 'RangeError',
    message: /positive safe integer/
  })
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}.png' }
        })
      ),
    /missing \{y\}/
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'xyz', urlTemplate: 'https://h/{z}/{x}/{y}/{z}.png' }
        })
      ),
    /must contain \{z\} exactly once/
  )
})

test('validateChartSource accepts empty optional text but rejects whitespace-only text', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource({ attribution: '' })))
  assert.throws(() => validateChartSource(makeSource({ attribution: '   ' })), /non-whitespace text/)
})

test('validateChartSource rejects malformed runtime shapes and unknown modes', () => {
  assert.throws(() => validateChartSource(null), /must be an object/)
  assert.throws(() => validateChartSource({ ...makeSource(), id: 123 }), /invalid source id/)
  assert.throws(() => validateChartSource({ ...makeSource(), upstream: { mode: 'bogus' } }), /unknown upstream mode/)
  assert.throws(() => validateChartSource({ ...makeSource(), group: { id: '', title: '' } }), /group id/)
  const sparseCoverage = Array<readonly [number, number, number, number]>(1)
  assert.throws(() => validateChartSource({ ...makeSource(), coverage: sparseCoverage }), {
    name: 'TypeError',
    message: /coverage must be a dense array/
  })
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

  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base: 'https://h/wms?token=x' } }),
    /query parameters/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, layers: 'layer&STYLES=evil' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, styles: 'ok#fragment' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, format: 'image/png\nX-Evil: yes' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, version: '1.1.1' } }),
    /version must be 1.3.0/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, format: '' } }),
    /between 1 and/
  )
  assert.throws(() => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, transparent: 'yes' } }), {
    name: 'TypeError',
    message: /must be boolean/
  })
})

test('validateChartSource rejects bare query and fragment markers, host tokens, ports, and plus signs', () => {
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base: 'https://h/wms?' } }),
    /query parameters/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base: 'https://h/wms#' } }),
    /fragment/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, layers: 'a+b' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate: 'https://{x}.h/{z}/{x}/{y}.png' } })),
    /template tokens in the host/
  )
  assert.throws(
    () => validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate: 'http://h/{z}/{x}/{y}.png' } })),
    /must use https/
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: {
            mode: 'style',
            styleUrl: 'https://tiles.example/style.json',
            allowedHosts: ['tiles.example:443']
          }
        })
      ),
    /not a valid host/
  )
})

test('every URL field rejects ports, address literals, and the loopback name', () => {
  // A source definition names a public chart service. Rejecting these at definition time is the
  // static half of the SSRF story; the consuming server still checks the address a name resolves to,
  // which is the only place a rebind can be caught.
  const rejected: ReadonlyArray<readonly [string, RegExp]> = [
    ['https://h:8443/wms', /must not include a port/],
    ['https://localhost/wms', /must not name the loopback host/],
    ['https://tiles.localhost/wms', /must not name the loopback host/],
    ['https://127.0.0.1/wms', /IP address literal/],
    ['https://169.254.169.254/wms', /IP address literal/],
    ['https://10.0.0.1/wms', /IP address literal/],
    // The URL parser rewrites the octal and integer spellings of 127.0.0.1 to the dotted quad, so
    // one pattern covers every way of writing the same address.
    ['https://0177.0.0.1/wms', /IP address literal/],
    ['https://2130706433/wms', /IP address literal/],
    ['https://[::1]/wms', /IP address literal/]
  ]
  for (const [base, message] of rejected) {
    assert.throws(() => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base } }), message, base)
    assert.throws(
      () => validateChartSource(makeSource({ upstream: { mode: 'arcgis', base } })),
      message,
      `arcgis ${base}`
    )
  }
  // The same rules reach a tile template, which is checked after its tokens are substituted.
  assert.throws(
    () => validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate: 'https://h:8443/{z}/{x}/{y}.png' } })),
    /must not include a port/
  )
  assert.throws(
    () =>
      validateChartSource(makeSource({ upstream: { mode: 'wmts', urlTemplate: 'https://127.0.0.1/{z}/{x}/{y}.png' } })),
    /IP address literal/
  )
  // And a style URL and its allowed hosts, which is where a proxy decides what to fetch.
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'style', styleUrl: 'https://127.0.0.1/style.json', allowedHosts: ['127.0.0.1'] }
        })
      ),
    /IP address literal/
  )
  assert.throws(
    () =>
      validateChartSource(
        makeSource({
          upstream: { mode: 'style', styleUrl: 'https://tiles.example/style.json', allowedHosts: ['localhost'] }
        })
      ),
    /must not name the loopback host/
  )
  // A hostname that merely contains a rejected substring is still a normal public host.
  assert.doesNotThrow(() =>
    validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base: 'https://localhost.example.org/wms' } })
  )
  // The parser drops an explicit default port, so this is indistinguishable from no port at all.
  assert.doesNotThrow(() =>
    validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, base: 'https://h:443/wms' } })
  )
})

test('an xyz tileJsonUrl is optional and validated like any other URL field', () => {
  const withTileJson = (tileJsonUrl: unknown) =>
    makeSource({
      upstream: {
        mode: 'xyz',
        urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
        tileJsonUrl
      } as never
    })
  assert.doesNotThrow(() => validateChartSource(withTileJson('https://tiles.example/tiles.json')))
  // Absent is the common case: only a service that publishes one declares it.
  assert.doesNotThrow(() => validateChartSource(makeSource()))
  for (const [value, message] of [
    ['http://tiles.example/tiles.json', /must use https/],
    ['https://127.0.0.1/tiles.json', /IP address literal/],
    ['https://tiles.example:8443/tiles.json', /must not include a port/],
    ['tiles.example/tiles.json', /absolute URL/]
  ] as const) {
    assert.throws(() => validateChartSource(withTileJson(value)), message, String(value))
  }
})

test('maxAgeSeconds must be absent or a positive safe integer', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource({ maxAgeSeconds: 300 })))
  // Absent is the common case: a static source must not be forced to declare a TTL.
  assert.doesNotThrow(() => validateChartSource(makeSource()))
  for (const value of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '300']) {
    assert.throws(
      () => validateChartSource(makeSource({ maxAgeSeconds: value as number })),
      /maxAgeSeconds must be a positive safe integer/,
      String(value)
    )
  }
})

test('WMS layer and style lists must be structurally answerable by a 1.3.0 server', () => {
  // Two layers, so a style list that does not pair with them is detectable.
  const wms = { ...wmsUpstream, layers: 'a,b' } as const
  // An empty STYLES asks for server defaults for every layer, which is the common catalog form.
  assert.doesNotThrow(() => validateChartSource({ ...makeSource(), upstream: wms }))
  assert.doesNotThrow(() => validateChartSource({ ...makeSource(), upstream: { ...wms, styles: 'x,y' } }))
  // An empty per-layer entry is the documented way to take the default for just that layer.
  assert.doesNotThrow(() => validateChartSource({ ...makeSource(), upstream: { ...wms, styles: 'x,' } }))

  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wms, styles: 'only-one' } }),
    /styles must be empty or name one style per layer/
  )
  for (const layers of ['a,,b', ',a', 'a,', ',,,']) {
    assert.throws(
      () => validateChartSource({ ...makeSource(), upstream: { ...wms, layers } }),
      /layers must not contain an empty layer name/,
      `layers ${JSON.stringify(layers)} must be rejected`
    )
  }
})

test('validateChartSource rejects invisible characters that change the host a URL resolves to', () => {
  // IDNA drops format characters, so this template reads as one host and would fetch another.
  assert.throws(
    () =>
      validateChartSource(
        makeSource({ upstream: { mode: 'xyz', urlTemplate: 'https://exa\u200Bmple.com/{z}/{x}/{y}.png' } })
      ),
    /invisible characters/
  )
  assert.throws(
    () =>
      validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate: 'https://h/\u202E{z}/{x}/{y}.png' } })),
    /invisible characters/
  )
  assert.throws(
    () =>
      validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate: 'https://h\uFEFF/{z}/{x}/{y}.png' } })),
    /invisible characters/
  )
})

test('validateChartSource rejects leftover braces and CGI separator characters', () => {
  for (const urlTemplate of [
    'https://h/{z}/{x}/{y}/{}.png',
    'https://h/{z}/{x}/{y}/{unclosed.png',
    'https://h/{z}/{x}/{y}/stray}.png'
  ]) {
    assert.throws(
      () => validateChartSource(makeSource({ upstream: { mode: 'xyz', urlTemplate } })),
      /unsupported template token/,
      `${urlTemplate} must be rejected`
    )
  }

  // A semicolon is a legacy query separator for CGI-style parsers, and an equals ends a parameter
  // name, so neither may ride inside a value the expander interpolates raw.
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, layers: 'a;b' } }),
    /must not contain/
  )
  assert.throws(
    () => validateChartSource({ ...makeSource(), upstream: { ...wmsUpstream, layers: 'a=b' } }),
    /must not contain/
  )
})

test('validateChartSource truncates rejected input instead of echoing it whole', () => {
  const huge = 'A'.repeat(5000)
  assert.throws(
    () => validateChartSource({ ...makeSource(), id: huge }),
    (error: unknown) => {
      assert.ok(error instanceof TypeError)
      assert.ok(error.message.length < 200, `message was ${error.message.length} characters`)
      assert.match(error.message, /\.\.\.$/)
      return true
    }
  )
})

test('bounded text is measured in UTF-8 bytes, not characters', () => {
  // The budget short-circuits on character count for the common cases, so a multibyte string near
  // the limit is what proves the helper is still counting bytes.
  const limit = 256
  assert.doesNotThrow(() => validateChartSource(makeSource({ title: 'a'.repeat(limit) })))
  assert.throws(() => validateChartSource(makeSource({ title: 'a'.repeat(limit + 1) })), /between 1 and 256/)
  // Each of these is three UTF-8 bytes, so 85 fit and 86 do not, even though 86 characters would.
  assert.doesNotThrow(() => validateChartSource(makeSource({ title: '€'.repeat(85) })))
  assert.throws(() => validateChartSource(makeSource({ title: '€'.repeat(86) })), /between 1 and 256/)
  // Astral characters are two UTF-16 units and four UTF-8 bytes.
  assert.doesNotThrow(() => validateChartSource(makeSource({ title: '\u{1F6A2}'.repeat(64) })))
  assert.throws(() => validateChartSource(makeSource({ title: '\u{1F6A2}'.repeat(65) })), /between 1 and 256/)
})

test('source text allows the whitespace controls markup uses and rejects the rest', () => {
  assert.doesNotThrow(() => validateChartSource(makeSource({ attribution: 'line one\nline two\r\tindented' })))
  for (const control of ['\u0000', '\u0001', '\u0007', '\u000B', '\u000C', '\u001B', '\u007F', '\u009F']) {
    assert.throws(
      () => validateChartSource(makeSource({ attribution: `credit${control}text` })),
      /without control characters/,
      `U+${control.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')} must be rejected`
    )
  }
})

test('validateChartSource enforces tileSize, vectorMaxzoom, and latitude bounds', () => {
  assert.throws(() => validateChartSource(makeSource({ tileSize: 128 as unknown as 256 })), {
    name: 'RangeError',
    message: /tileSize must be 256 or 512/
  })
  assert.throws(() => validateChartSource(makeSource({ tileSize: '256' as unknown as 256 })), {
    name: 'RangeError',
    message: /tileSize must be 256 or 512/
  })
  assert.doesNotThrow(() => validateChartSource(makeSource({ minzoom: 2, maxzoom: 10, vectorMaxzoom: 6 })))
  assert.throws(
    () => validateChartSource(makeSource({ minzoom: 2, maxzoom: 10, vectorMaxzoom: 11 })),
    /vectorMaxzoom must fall within/
  )
  assert.throws(
    () => validateChartSource(makeSource({ minzoom: 2, maxzoom: 10, vectorMaxzoom: 1 })),
    /vectorMaxzoom must fall within/
  )
  assert.throws(() => validateChartSource(makeSource({ bounds: [-1, -91, 1, 1] })), /latitudes must fall within/)
  assert.throws(() => validateChartSource(makeSource({ bounds: [-1, -1, 1, 91] })), /latitudes must fall within/)
  assert.throws(() => validateChartSource(makeSource({ bounds: [-181, -1, 1, 1] })), /longitudes must fall within/)
  assert.throws(() => validateChartSource(makeSource({ bounds: [1, -1, 181, 1] })), /longitudes must fall within/)
})

test('style and base URLs must be absolute https, not just template URLs', () => {
  const style = (styleUrl: string): unknown =>
    makeSource({ upstream: { mode: 'style', styleUrl, allowedHosts: ['tiles.example'] } })
  assert.throws(() => validateChartSource(style('http://tiles.example/s.json')), /must use https/)
  assert.throws(() => validateChartSource(style('/relative/s.json')), /must be an absolute URL/)
  assert.throws(() => validateChartSource(style('not a url')), /must not contain whitespace/)
  assert.throws(() => validateChartSource(style('https://tiles.example/s.json#frag')), /fragment/)

  const arcgis = (base: string): unknown => makeSource({ upstream: { mode: 'arcgis', base } })
  assert.throws(() => validateChartSource(arcgis('ftp://h/MapServer')), /must use https/)
  assert.throws(() => validateChartSource(arcgis('MapServer')), /must be an absolute URL/)
})

test('validateChartSource rejects a zero-width bounds box', () => {
  assert.throws(() => validateChartSource(makeSource({ bounds: [10, 0, 10, 10] })), /non-zero area/)
  assert.throws(() => validateChartSource(makeSource({ coverage: [[10, 0, 10, 10]] })), /non-zero area/)
})

test('coverage and allowedHosts reject lists longer than their documented bounds', () => {
  const boxes = Array.from({ length: 65 }, (_, index) => [index - 60, 0, index - 59.5, 1] as const)
  assert.throws(() => validateChartSource(makeSource({ coverage: boxes })), {
    name: 'RangeError',
    message: /between 1 and 64 boxes/
  })
  const hosts = Array.from({ length: 33 }, (_, index) => `h${index}.example`)
  assert.throws(
    () =>
      validateChartSource(
        makeSource({ upstream: { mode: 'style', styleUrl: 'https://h0.example/s.json', allowedHosts: hosts } })
      ),
    { name: 'RangeError', message: /between 1 and 32 hosts/ }
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
    /allowedHosts must be an array/
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
