import type { ChartSource, LngLatBbox, ZoomRange } from './types.js'

/** Highest zoom accepted by public tile and source validation. */
export const MAX_TILE_ZOOM = 30

const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
// Semicolon joins the separator characters because CGI-style parsers have long accepted it as an
// alternative to "&", and equals would end the parameter name a server reads.
const INVALID_QUERY_VALUE_CHARACTER = /[&?#+;=]/
/** Longest rejected value echoed back in an error, so a hostile input cannot flood a log. */
const MAX_ECHOED_VALUE = 64
// Any control character at all, then the narrower question of whether a disallowed one is present.
// The cheap test carries the common case; the double negation reads as "a control that is not tab,
// line feed, or carriage return", which a character class cannot say without literal controls that
// the linter rejects.
const TEXT_CONTROL = /\p{Cc}/u
const DISALLOWED_TEXT_CONTROL = /[^\P{Cc}\t\n\r]/u
// Whitespace plus every invisible character class a URL must not carry. Format characters matter
// most: IDNA drops them, so a host carrying a zero-width space validates as written yet
// resolves to a different host.
const INVALID_URL_CHARACTER = /[\s\p{Cc}\p{Cf}\p{Cs}]/u
const UTF8 = new TextEncoder()

const MAX_SOURCE_ID_BYTES = 256
const MAX_TITLE_BYTES = 256
const MAX_ATTRIBUTION_BYTES = 16 * 1024
const MAX_URL_BYTES = 4 * 1024
const MAX_COVERAGE_BOXES = 64
const MAX_WMS_LAYER_BYTES = 1024
const MAX_WMS_STYLE_BYTES = 1024
const MAX_WMS_FORMAT_BYTES = 128
const MAX_ALLOWED_HOSTS = 32
const MAX_HOST_BYTES = 253

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
}

/** Describe a rejected value for an error message without trusting its toString or its length. */
function describeValue(value: unknown): string {
  let text: string
  try {
    text = String(value)
  } catch {
    text = Object.prototype.toString.call(value)
  }
  return text.length > MAX_ECHOED_VALUE ? `${text.slice(0, MAX_ECHOED_VALUE)}...` : text
}

/**
 * Require a dense array of a bounded length. Sparse arrays are rejected outright because a hole
 * reads as undefined and would slip past a per-entry check.
 */
function assertBoundedArray(
  value: unknown,
  label: string,
  noun: string,
  max: number
): asserts value is readonly unknown[] {
  // Iterate by index rather than with some or every, which skip holes and would report a sparse
  // array as dense.
  if (!Array.isArray(value)) throw new TypeError(`${label} must be a dense array`)
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense array`)
  }
  if (value.length === 0 || value.length > max) {
    throw new RangeError(`${label} must contain between 1 and ${max} ${noun}`)
  }
}

/**
 * Report whether a string exceeds a UTF-8 byte budget. Every UTF-16 code unit encodes to between one
 * and three UTF-8 bytes, so both common cases answer without encoding a copy of the string. This runs
 * on every source field of every validation, including the per-tile revalidation in expandUpstreamUrl.
 */
function exceedsUtf8Bytes(value: string, maxBytes: number): boolean {
  if (value.length > maxBytes) return true
  if (value.length * 3 <= maxBytes) return false
  return UTF8.encode(value).byteLength > maxBytes
}

/** Reject control characters in displayed text, allowing only the whitespace forms markup uses. */
function containsInvalidTextControl(value: string): boolean {
  return TEXT_CONTROL.test(value) && DISALLOWED_TEXT_CONTROL.test(value)
}

export function containsInvalidUrlCharacter(value: string): boolean {
  return INVALID_URL_CHARACTER.test(value)
}

function assertBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  // An optional field accepts the empty string but never non-empty whitespace-only text.
  const blank = value.trim() === '' && (!allowEmpty || value !== '')
  if (blank || exceedsUtf8Bytes(value, maxBytes) || containsInvalidTextControl(value)) {
    throw new TypeError(
      `${label} must be ${allowEmpty ? 'empty or at most' : 'between 1 and'} ${maxBytes} UTF-8 bytes of non-whitespace text without control characters`
    )
  }
}

export function assertSourceId(value: unknown, label = 'source id'): asserts value is string {
  if (typeof value !== 'string' || exceedsUtf8Bytes(value, MAX_SOURCE_ID_BYTES) || !SOURCE_ID.test(value)) {
    throw new TypeError(`invalid ${label}: ${describeValue(value)}`)
  }
}

export function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

export function assertZoom(z: unknown, label = 'zoom'): asserts z is number {
  if (typeof z !== 'number' || !Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new RangeError(`${label} must be an integer between 0 and ${MAX_TILE_ZOOM}`)
  }
}

export function assertZoomRange(value: unknown): asserts value is ZoomRange {
  if (!Array.isArray(value) || value.length !== 2 || !Object.hasOwn(value, 0) || !Object.hasOwn(value, 1)) {
    throw new RangeError('zoom range must contain exactly two values')
  }
  const [zmin, zmax] = value
  assertZoom(zmin, 'minimum zoom')
  assertZoom(zmax, 'maximum zoom')
  if (zmin > zmax) throw new RangeError('minimum zoom must not exceed maximum zoom')
}

export function assertTileCoordinate(z: number, x: number, y: number): void {
  assertZoom(z)
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`x and y must be integers at z ${z}`)
  }
  const span = 2 ** z
  if (x < 0 || x >= span || y < 0 || y >= span) {
    throw new RangeError(`x/y ${x}/${y} out of range at z ${z}`)
  }
}

export function assertLngLatBbox(value: unknown, label = 'bbox'): asserts value is LngLatBbox {
  if (
    !Array.isArray(value) ||
    value.length !== 4 ||
    ![0, 1, 2, 3].every((index) => Object.hasOwn(value, index)) ||
    !value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))
  ) {
    throw new RangeError(`${label} must contain four finite coordinates`)
  }
  const [west, south, east, north] = value
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new RangeError(`${label} longitudes must fall within [-180, 180]`)
  }
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new RangeError(`${label} latitudes must fall within [-90, 90]`)
  }
  // west > east wraps the antimeridian. west === east has no width at all, so it must not fall into
  // the wrap arm and read as a full 360 degree span.
  const longitudeSpan = west < east ? east - west : west > east ? 360 - west + east : 0
  if (longitudeSpan <= 0 || south >= north) throw new RangeError(`${label} must cover a non-zero area`)
}

function parseHttpsUrl(value: unknown, label: string): URL {
  assertBoundedText(value, label, MAX_URL_BYTES)
  if (containsInvalidUrlCharacter(value))
    throw new TypeError(`${label} must not contain whitespace, control, or invisible characters`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${label} must use https`)
  if (url.hostname === '') throw new TypeError(`${label} must include a host`)
  if (url.username !== '' || url.password !== '') throw new TypeError(`${label} must not include credentials`)
  // A bare trailing "#" parses to an empty hash, so check the raw text as well.
  if (url.hash !== '' || value.includes('#')) throw new TypeError(`${label} must not include a fragment`)
  return url
}

function assertCleanBaseUrl(value: unknown, label: string): void {
  const url = parseHttpsUrl(value, label)
  // A bare trailing "?" parses to an empty search, so check the raw text as well.
  if (url.search !== '' || (typeof value === 'string' && value.includes('?'))) {
    throw new TypeError(`${label} must not include query parameters`)
  }
}

function assertTemplate(value: unknown, label: string): void {
  assertBoundedText(value, label, MAX_URL_BYTES)
  if (!value.startsWith('https://')) throw new TypeError(`${label} must use https`)
  // Check the host before the token rules so a host token gets the more specific error. The class
  // matches every character that ends an authority for the URL parser, backslash included.
  const authority = value.slice('https://'.length).split(/[/\\?#]/, 1)[0] ?? ''
  if (authority.includes('{')) throw new TypeError(`${label} must not use template tokens in the host`)
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!value.includes(token)) throw new TypeError(`${label} is missing ${token}`)
    // A repeated token still expands to a valid URL, so it would silently mask a typo.
    if (value.indexOf(token) !== value.lastIndexOf(token)) {
      throw new TypeError(`${label} must contain ${token} exactly once`)
    }
  }
  const expanded = value.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0')
  // Any brace left over is an unsupported token, an empty pair, or an unclosed one, all of which
  // would reach the upstream verbatim.
  if (expanded.includes('{') || expanded.includes('}')) {
    throw new TypeError(`${label} contains an unsupported template token`)
  }
  parseHttpsUrl(expanded, label)
}

function assertQueryValue(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is string {
  assertBoundedText(value, label, maxBytes, allowEmpty)
  if (containsInvalidUrlCharacter(value) || INVALID_QUERY_VALUE_CHARACTER.test(value)) {
    throw new TypeError(`${label} must not contain whitespace, controls, invisibles, &, ?, #, or +`)
  }
}

/**
 * WMS 1.3.0 requires one STYLES entry per LAYERS entry, or an empty STYLES for server defaults, so a
 * misaligned pair builds a GetMap request no compliant server can answer.
 */
function assertWmsLayerLists(layers: string, styles: string, id: string): void {
  const names = layers.split(',')
  if (names.includes('')) throw new TypeError(`${id} WMS layers must not contain an empty layer name`)
  if (styles !== '' && styles.split(',').length !== names.length) {
    throw new TypeError(`${id} WMS styles must be empty or name one style per layer`)
  }
}

function normalizedHost(value: unknown, label: string): string {
  assertBoundedText(value, label, MAX_HOST_BYTES)
  if (containsInvalidUrlCharacter(value) || /[/@:?#]/.test(value)) throw new TypeError(`${label} is not a valid host`)
  let url: URL
  try {
    url = new URL(`https://${value}`)
  } catch {
    throw new TypeError(`${label} is not a valid host`)
  }
  if (
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.hostname === ''
  ) {
    throw new TypeError(`${label} is not a valid host`)
  }
  return url.hostname.toLowerCase()
}

/**
 * Validate and narrow a built-in or consumer-supplied source.
 *
 * @throws {TypeError | RangeError} When identity, bounded text, zooms, geography, fallback size,
 * HTTPS URLs, URL tokens, WMS parameters, or style-host authorization are invalid.
 */
export function validateChartSource(source: unknown): asserts source is ChartSource {
  assertRecord(source, 'chart source')
  assertSourceId(source['id'])
  const id = source['id']
  assertBoundedText(source['title'], `${id} title`, MAX_TITLE_BYTES)
  assertBoundedText(source['attribution'], `${id} attribution`, MAX_ATTRIBUTION_BYTES, true)

  if (source['tileSize'] !== 256 && source['tileSize'] !== 512) {
    throw new RangeError(`${id} tileSize must be 256 or 512`)
  }
  const minzoom = source['minzoom']
  const maxzoom = source['maxzoom']
  assertZoom(minzoom, `${id} minzoom`)
  assertZoom(maxzoom, `${id} maxzoom`)
  if (minzoom > maxzoom) throw new RangeError(`${id} minzoom exceeds maxzoom`)

  const vectorMaxzoom = source['vectorMaxzoom']
  if (vectorMaxzoom !== undefined) {
    assertZoom(vectorMaxzoom, `${id} vectorMaxzoom`)
    if (vectorMaxzoom < minzoom || vectorMaxzoom > maxzoom) {
      throw new RangeError(`${id} vectorMaxzoom must fall within its zoom range`)
    }
  }

  const bounds = source['bounds']
  if (bounds !== undefined) assertLngLatBbox(bounds, `${id} bounds`)
  const coverage = source['coverage']
  if (coverage !== undefined) {
    assertBoundedArray(coverage, `${id} coverage`, 'boxes', MAX_COVERAGE_BOXES)
    coverage.forEach((bbox, index) => {
      assertLngLatBbox(bbox, `${id} coverage[${index}]`)
    })
  }

  const fallbackTileBytes = source['fallbackTileBytes']
  if (
    fallbackTileBytes !== undefined &&
    (typeof fallbackTileBytes !== 'number' || !Number.isSafeInteger(fallbackTileBytes) || fallbackTileBytes <= 0)
  ) {
    throw new RangeError(`${id} fallbackTileBytes must be a positive safe integer`)
  }

  const group = source['group']
  if (group !== undefined) {
    assertRecord(group, `${id} group`)
    assertSourceId(group['id'], `${id} group id`)
    assertBoundedText(group['title'], `${id} group title`, MAX_TITLE_BYTES)
  }

  const upstream = source['upstream']
  assertRecord(upstream, `${id} upstream`)
  switch (upstream['mode']) {
    case 'xyz':
    case 'wmts':
      assertTemplate(upstream['urlTemplate'], `${id} template`)
      break
    case 'wms': {
      const layers = upstream['layers']
      const styles = upstream['styles']
      assertCleanBaseUrl(upstream['base'], `${id} WMS base`)
      assertQueryValue(layers, `${id} WMS layers`, MAX_WMS_LAYER_BYTES)
      assertQueryValue(styles, `${id} WMS styles`, MAX_WMS_STYLE_BYTES, true)
      assertWmsLayerLists(layers, styles, id)
      if (upstream['version'] !== '1.3.0') throw new TypeError(`${id} WMS version must be 1.3.0`)
      assertQueryValue(upstream['format'], `${id} WMS format`, MAX_WMS_FORMAT_BYTES)
      if (typeof upstream['transparent'] !== 'boolean') throw new TypeError(`${id} WMS transparent must be boolean`)
      break
    }
    case 'arcgis':
      assertCleanBaseUrl(upstream['base'], `${id} ArcGIS base`)
      break
    case 'style': {
      const styleUrl = parseHttpsUrl(upstream['styleUrl'], `${id} style URL`)
      const allowedHosts = upstream['allowedHosts']
      assertBoundedArray(allowedHosts, `${id} allowedHosts`, 'hosts', MAX_ALLOWED_HOSTS)
      const hosts = allowedHosts.map((host, index) => normalizedHost(host, `${id} allowedHosts[${index}]`))
      if (new Set(hosts).size !== hosts.length) throw new TypeError(`${id} allowedHosts must not contain duplicates`)
      if (!hosts.includes(styleUrl.hostname.toLowerCase())) {
        throw new TypeError(`${id} allowedHosts must include ${styleUrl.hostname}`)
      }
      break
    }
    default:
      throw new TypeError(`${id} has an unknown upstream mode: ${describeValue(upstream['mode'])}`)
  }
}
