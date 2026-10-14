import assert from 'node:assert/strict'
import test from 'node:test'
import {
  checkedPublicHttpsUrl,
  errorMessage,
  HttpStatusError,
  isTransientFetchFailure,
  rethrowUnreachable,
  retryDelayMs,
  UpstreamUnreachableError
} from '../scripts/upstream-url.js'

test('upstream monitor URLs require a public HTTPS host', () => {
  assert.equal(checkedPublicHttpsUrl('https://charts.example.test/data').hostname, 'charts.example.test')
  assert.equal(
    checkedPublicHttpsUrl('../tiles.json', 'https://charts.example.test/styles/base.json').href,
    'https://charts.example.test/tiles.json'
  )
  // The parser drops an explicit default port, so it is the same URL as one without a port.
  assert.equal(checkedPublicHttpsUrl('https://charts.example.test:443/data').port, '')

  for (const [url, message] of [
    ['http://charts.example.test/data', /must use https/],
    ['https://user:secret@charts.example.test/data', /must not include credentials/],
    ['https://charts.example.test:8443/data', /must not include a port/],
    ['https://charts.example.test/data#frag', /must not include a fragment/],
    ['https://localhost/data', /loopback/],
    ['https://tiles.localhost/data', /loopback/],
    ['https://localhost./data', /trailing dot/],
    ['https://foo.localhost./data', /trailing dot/],
    ['https://localhost../data', /empty label or a trailing dot/],
    ['https://charts.example.test./data', /trailing dot/],
    ['https://127.0.0.1/data', /IP address literal/],
    ['https://169.254.169.254/data', /IP address literal/],
    ['https://[::1]/data', /IP address literal/]
  ] as const) {
    assert.throws(() => checkedPublicHttpsUrl(url), message, url)
  }
})

test('upstream monitor redirect locations resolve before they are checked', () => {
  const base = 'https://charts.example.test/styles/base.json'
  assert.equal(checkedPublicHttpsUrl('//tiles.example.test/x', base).href, 'https://tiles.example.test/x')
  for (const [location, message] of [
    ['//localhost./x', /trailing dot/],
    ['//localhost/x', /loopback/],
    ['//charts.example.test:8443/x', /must not include a port/],
    ['http://charts.example.test/x', /must use https/],
    ['https://127.0.0.1/x', /IP address literal/]
  ] as const) {
    assert.throws(() => checkedPublicHttpsUrl(location, base), message, location)
  }
})

test('only an unreachable upstream or a transient status is retried', () => {
  const url = 'https://charts.example.test/tile.png'
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientFetchFailure(new HttpStatusError(url, status)), true, `HTTP ${status}`)
  }
  // A missing layer, a refused request, or a broken service answers the same way every time.
  for (const status of [400, 401, 403, 404, 410, 501]) {
    assert.equal(isTransientFetchFailure(new HttpStatusError(url, status)), false, `HTTP ${status}`)
  }
  assert.equal(isTransientFetchFailure(new UpstreamUnreachableError(url, new TypeError('fetch failed'))), true)
  // A response the monitor itself rejected, such as an oversized body or a redirect to a private
  // host, would be rejected again.
  assert.equal(isTransientFetchFailure(new assert.AssertionError({ message: 'oversized' })), false)
  assert.equal(isTransientFetchFailure(new TypeError('must use https')), false)
  assert.equal(isTransientFetchFailure('not an error'), false)
})

test('fetch failures name the URL and the underlying cause, not a bare "fetch failed"', () => {
  const url = 'https://charts.example.test/tile.png'
  assert.equal(new HttpStatusError(url, 502).message, `${url} returned HTTP 502`)
  assert.equal(new HttpStatusError(url, 502).status, 502)
  const lookup = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND charts.example.test') })
  const unreachable = new UpstreamUnreachableError(url, lookup)
  assert.equal(
    unreachable.message,
    `${url} could not be fetched: fetch failed (getaddrinfo ENOTFOUND charts.example.test)`
  )
  assert.equal(unreachable.cause, lookup)
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  assert.equal(
    new UpstreamUnreachableError(url, timeout).message,
    `${url} could not be fetched: The operation was aborted due to timeout`
  )
  assert.equal(
    new UpstreamUnreachableError(url, 'socket hang up').message,
    `${url} could not be fetched: socket hang up`
  )
})

test('a failed request or body read is rethrown as unreachable, and so retried', async () => {
  const url = 'https://charts.example.test/tile.png'
  const reset = new TypeError('terminated', { cause: new Error('other side closed') })
  await assert.rejects(Promise.reject(reset).catch(rethrowUnreachable(url)), (error: unknown) => {
    assert.ok(error instanceof UpstreamUnreachableError)
    assert.equal(error.message, `${url} could not be fetched: terminated (other side closed)`)
    assert.equal(isTransientFetchFailure(error), true)
    return true
  })
})

test('errors read the same way in the report and in the retry path', () => {
  assert.equal(errorMessage(new RangeError('out of range')), 'out of range')
  assert.equal(errorMessage('a thrown string'), 'a thrown string')
  // A cause that is not an Error is still described, not dropped.
  const url = 'https://charts.example.test/tile.png'
  assert.equal(
    new UpstreamUnreachableError(url, new TypeError('fetch failed', { cause: 'ECONNRESET' })).message,
    `${url} could not be fetched: fetch failed (ECONNRESET)`
  )
})

test('retries pause about 2 then 6 seconds, jittered a fifth either way, and then stop', () => {
  assert.equal(
    retryDelayMs(0, () => 0),
    1_600
  )
  assert.equal(
    retryDelayMs(0, () => 0.5),
    2_000
  )
  assert.ok((retryDelayMs(0, () => 0.999_999) ?? 0) < 2_400)
  assert.equal(
    retryDelayMs(1, () => 0),
    4_800
  )
  assert.equal(
    retryDelayMs(1, () => 0.5),
    6_000
  )
  assert.equal(retryDelayMs(2), undefined)
  for (let draw = 0; draw < 100; draw++) {
    const delay = retryDelayMs(1)
    assert.ok(delay !== undefined && delay >= 4_800 && delay < 7_200, `jittered delay ${delay}`)
  }
})
