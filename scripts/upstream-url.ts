import { assertPublicHttpsUrlShape } from '../src/validate.js'

/** Validate an initial or redirected URL used by the scheduled upstream monitor. */
export function checkedPublicHttpsUrl(value: string, base?: string): URL {
  const url = new URL(value, base)
  // The same shape catalog URLs must have: a public service on the default port, with nothing after
  // the request target that a server never sees anyway.
  assertPublicHttpsUrlShape(url, url.href)
  return url
}
