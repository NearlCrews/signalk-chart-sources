import assert from 'node:assert/strict'
import test from 'node:test'
import { checkedPublicHttpsUrl } from '../scripts/upstream-url.js'

test('upstream monitor URLs require a public HTTPS host', () => {
  assert.equal(checkedPublicHttpsUrl('https://charts.example.test/data').hostname, 'charts.example.test')
  assert.equal(
    checkedPublicHttpsUrl('../tiles.json', 'https://charts.example.test/styles/base.json').href,
    'https://charts.example.test/tiles.json'
  )

  for (const url of [
    'http://charts.example.test/data',
    'https://user:secret@charts.example.test/data',
    'https://localhost/data',
    'https://tiles.localhost/data',
    'https://127.0.0.1/data',
    'https://169.254.169.254/data',
    'https://[::1]/data'
  ]) {
    assert.throws(() => checkedPublicHttpsUrl(url), url)
  }
})
