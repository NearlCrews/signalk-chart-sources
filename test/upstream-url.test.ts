import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedPublicHttpsUrl } from '../scripts/upstream-url.js'

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
