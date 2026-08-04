import assert from 'node:assert/strict'
import { assertPublicHost } from '../src/validate.js'

/** Validate an initial or redirected URL used by the scheduled upstream monitor. */
export function checkedPublicHttpsUrl(value: string, base?: string): URL {
  const url = new URL(value, base)
  assert.equal(url.protocol, 'https:', `${url} must use HTTPS`)
  assert.equal(url.username, '', `${url} must not include credentials`)
  assert.equal(url.password, '', `${url} must not include credentials`)
  assertPublicHost(url.hostname, `${url} host`)
  return url
}
