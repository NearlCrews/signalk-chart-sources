import type { ChartSource, LngLatBbox, ZoomRange } from './types.js'

/** Highest zoom accepted by public tile and source validation. */
export const MAX_TILE_ZOOM = 30

const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const INVALID_QUERY_VALUE_CHARACTER = /[&?#]/
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

function utf8Length(value: string): number {
  return UTF8.encode(value).byteLength
}

function containsInvalidTextControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
  })
}

function containsInvalidUrlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return /\s/u.test(character) || code <= 31 || code === 127
  })
}

function assertBoundedText(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if ((!allowEmpty && value.trim() === '') || utf8Length(value) > maxBytes || containsInvalidTextControl(value)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${maxBytes} UTF-8 bytes`)
  }
}

function assertSourceId(value: unknown, label = 'source id'): asserts value is string {
  if (typeof value !== 'string' || utf8Length(value) > MAX_SOURCE_ID_BYTES || !SOURCE_ID.test(value)) {
    throw new TypeError(`invalid ${label}: ${String(value)}`)
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
  const longitudeSpan = west < east ? east - west : 360 - west + east
  if (longitudeSpan <= 0 || south >= north) throw new RangeError(`${label} must cover a non-zero area`)
}

function parseHttpsUrl(value: unknown, label: string): URL {
  assertBoundedText(value, label, MAX_URL_BYTES)
  if (containsInvalidUrlCharacter(value))
    throw new TypeError(`${label} must not contain whitespace or control characters`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${label} must use https`)
  if (url.hostname === '') throw new TypeError(`${label} must include a host`)
  if (url.username !== '' || url.password !== '') throw new TypeError(`${label} must not include credentials`)
  if (url.hash !== '') throw new TypeError(`${label} must not include a fragment`)
  return url
}

function assertCleanBaseUrl(value: unknown, label: string): void {
  const url = parseHttpsUrl(value, label)
  if (url.search !== '') throw new TypeError(`${label} must not include query parameters`)
}

function assertTemplate(value: unknown, label: string): void {
  assertBoundedText(value, label, MAX_URL_BYTES)
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!value.includes(token)) throw new TypeError(`${label} is missing ${token}`)
  }
  const expanded = value.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0')
  if (/\{[^}]+\}/.test(expanded)) throw new TypeError(`${label} contains an unsupported template token`)
  parseHttpsUrl(expanded, label)
}

function assertQueryValue(value: unknown, label: string, maxBytes: number, allowEmpty = false): void {
  assertBoundedText(value, label, maxBytes, allowEmpty)
  if (containsInvalidUrlCharacter(value) || INVALID_QUERY_VALUE_CHARACTER.test(value)) {
    throw new TypeError(`${label} must not contain whitespace, controls, &, ?, or #`)
  }
}

function normalizedHost(value: unknown, label: string): string {
  assertBoundedText(value, label, MAX_HOST_BYTES)
  if (containsInvalidUrlCharacter(value) || /[/@?#]/.test(value)) throw new TypeError(`${label} is not a valid host`)
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
    if (
      !Array.isArray(coverage) ||
      coverage.length === 0 ||
      coverage.length > MAX_COVERAGE_BOXES ||
      !Array.from({ length: coverage.length }, (_, index) => Object.hasOwn(coverage, index)).every(Boolean)
    ) {
      throw new RangeError(`${id} coverage must contain between 1 and ${MAX_COVERAGE_BOXES} boxes`)
    }
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
    case 'wms':
      assertCleanBaseUrl(upstream['base'], `${id} WMS base`)
      assertQueryValue(upstream['layers'], `${id} WMS layers`, MAX_WMS_LAYER_BYTES)
      assertQueryValue(upstream['styles'], `${id} WMS styles`, MAX_WMS_STYLE_BYTES, true)
      if (upstream['version'] !== '1.3.0') throw new TypeError(`${id} WMS version must be 1.3.0`)
      assertQueryValue(upstream['format'], `${id} WMS format`, MAX_WMS_FORMAT_BYTES)
      if (typeof upstream['transparent'] !== 'boolean') throw new TypeError(`${id} WMS transparent must be boolean`)
      break
    case 'arcgis':
      assertCleanBaseUrl(upstream['base'], `${id} ArcGIS base`)
      break
    case 'style': {
      const styleUrl = parseHttpsUrl(upstream['styleUrl'], `${id} style URL`)
      const allowedHosts = upstream['allowedHosts']
      if (
        !Array.isArray(allowedHosts) ||
        allowedHosts.length === 0 ||
        allowedHosts.length > MAX_ALLOWED_HOSTS ||
        !Array.from({ length: allowedHosts.length }, (_, index) => Object.hasOwn(allowedHosts, index)).every(Boolean)
      ) {
        throw new TypeError(`${id} allowedHosts must contain between 1 and ${MAX_ALLOWED_HOSTS} hosts`)
      }
      const hosts = allowedHosts.map((host, index) => normalizedHost(host, `${id} allowedHosts[${index}]`))
      if (new Set(hosts).size !== hosts.length) throw new TypeError(`${id} allowedHosts must not contain duplicates`)
      if (!hosts.includes(styleUrl.hostname.toLowerCase())) {
        throw new TypeError(`${id} allowedHosts must include ${styleUrl.hostname}`)
      }
      break
    }
    default:
      throw new TypeError(`${id} has an unknown upstream mode: ${String(upstream['mode'])}`)
  }
}
