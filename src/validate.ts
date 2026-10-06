import { bboxRequestUrl, MAPLIBRE_BBOX_TOKEN, substituteZXY } from './request.js'
import type { ChartSource, LngLatBbox, ZoomRange } from './types.js'

/** Highest zoom accepted by public tile and source validation. */
export const MAX_TILE_ZOOM = 30

/** The one WMS protocol version the catalog speaks, shared so the builder and validator agree. */
export const WMS_VERSION = '1.3.0'

const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
// Semicolon joins the separator characters because CGI-style parsers have long accepted it as an
// alternative to "&", and equals would end the parameter name a server reads. Percent is here
// because the server decodes escapes after splitting the query, so "%2C" would add a layer the
// STYLES pairing never counted and "%0A" would deliver a control character this check bans. Braces
// are checked on the whole request instead, by assertOnlyBboxToken.
const INVALID_QUERY_VALUE_CHARACTER = /[%&?#+;=]/
/**
 * Longest rejected value echoed back in an error, so a hostile input cannot flood a log. Counted in
 * UTF-16 code units, unlike the wire budgets below: the echo is log text, so a loose bound is fine.
 */
const MAX_ECHOED_VALUE = 64
// Characters escaped in an echoed value: controls and the line and paragraph separators, so a line
// break cannot forge a second log line; format characters, so a bidirectional override cannot reorder
// what the reader sees; and lone surrogates, which the truncation can leave behind by splitting a pair.
const UNSAFE_ECHO_CHARACTER = /[\p{Cc}\p{Zl}\p{Zp}\p{Cf}\p{Cs}]/gu
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

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
}

function escapeEchoCharacter(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0
  const hex = codePoint.toString(16).toUpperCase()
  return codePoint > 0xffff ? `\\u{${hex}}` : `\\u${hex.padStart(4, '0')}`
}

/**
 * Describe a rejected value for an error message without trusting its toString, its length, or its
 * characters. Truncation runs first so the escapes cannot be cut in half.
 */
export function describeValue(value: unknown): string {
  let text: string
  try {
    text = String(value)
  } catch {
    text = Object.prototype.toString.call(value)
  }
  const truncated = text.length > MAX_ECHOED_VALUE
  const shown = (truncated ? text.slice(0, MAX_ECHOED_VALUE) : text).replace(UNSAFE_ECHO_CHARACTER, escapeEchoCharacter)
  return truncated ? `${shown}...` : shown
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
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  // The length bound comes before the hole scan, so an oversized array is refused without walking it.
  if (value.length === 0 || value.length > max) {
    throw new RangeError(`${label} must contain between 1 and ${max} ${noun}`)
  }
  // Iterate by index rather than with some or every, which skip holes and would report a sparse
  // array as dense.
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must be a dense array`)
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

// Renderers such as MapLibre insert attribution as HTML, and a catalog credit may link its license, so
// the one markup form accepted is an anchor to an https page, written exactly this way. The optional
// target="_blank" is what OpenFreeMap's own TileJSON credit carries, transcribed verbatim, and modern
// browsers give such a link no opener.
const ATTRIBUTION_LINK = /<a href="https:\/\/[^"\s<>]+"(?: target="_blank")?>[^<]*<\/a>/g

/** Require attribution text whose only markup is ATTRIBUTION_LINK anchors. */
function assertAttribution(value: unknown, label: string): asserts value is string {
  assertBoundedText(value, label, MAX_ATTRIBUTION_BYTES, true)
  if (value.includes('<') && value.replace(ATTRIBUTION_LINK, '').includes('<')) {
    throw new TypeError(`${label} must be plain text apart from <a href="https://..."> links`)
  }
}

export function assertSourceId(value: unknown, label = 'source id'): asserts value is string {
  if (typeof value !== 'string' || exceedsUtf8Bytes(value, MAX_SOURCE_ID_BYTES) || !SOURCE_ID.test(value)) {
    throw new TypeError(`invalid ${label}: ${describeValue(value)}`)
  }
}

function assertFiniteNumber(value: unknown, label: string): asserts value is number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

/** Require a finite point. Range is the caller's question: tile math clamps, and coversPoint answers false. */
export function assertLngLat(lng: number, lat: number): void {
  assertFiniteNumber(lng, 'longitude')
  assertFiniteNumber(lat, 'latitude')
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
  const wrongShape = `${label} must contain four finite coordinates`
  if (!Array.isArray(value) || value.length !== 4) throw new RangeError(wrongShape)
  // Indexed rather than [0,1,2,3].every(...) plus value.every(...): a source may carry up to 64
  // coverage boxes and this runs per box, per validation, and expandUpstreamUrl revalidates the
  // whole source on every tile. The array-and-closure form allocated twice per box.
  for (let index = 0; index < 4; index++) {
    const coordinate: unknown = value[index]
    if (!Object.hasOwn(value, index) || typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      throw new RangeError(wrongShape)
    }
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

/** Split a box at the antimeridian without revalidating: for boxes a validator already accepted. */
export function splitValidBbox(bbox: LngLatBbox): LngLatBbox[] {
  const [west, south, east, north] = bbox
  if (west < east) return [[west, south, east, north]]
  return [
    [west, south, 180, north],
    [-180, south, east, north]
  ]
}

/**
 * Whether the longitudes [west, east], with west <= east, lie inside one interval of the envelope: its
 * own span, or for an envelope crossing the antimeridian, either [bounds west, 180] or [-180, bounds east].
 */
const withinLongitudes = (west: number, east: number, bounds: LngLatBbox): boolean =>
  bounds[0] < bounds[2] ? bounds[0] <= west && east <= bounds[2] : bounds[0] <= west || east <= bounds[2]

/**
 * Whether a coverage box lies inside the display envelope, compared edge by edge without splitting
 * either box. Both may cross the antimeridian, and a crossing box needs both its pieces, [west, 180]
 * and [-180, east], inside. A piece of zero width on the antimeridian itself covers nothing and is
 * skipped. A valid box always keeps one piece of non-zero width, so latitude settles first.
 */
function withinBounds(box: LngLatBbox, bounds: LngLatBbox): boolean {
  if (box[1] < bounds[1] || box[3] > bounds[3]) return false
  const west = box[0]
  const east = box[2]
  if (west < east) return withinLongitudes(west, east, bounds)
  return (
    (west === 180 || withinLongitudes(west, 180, bounds)) && (east === -180 || withinLongitudes(-180, east, bounds))
  )
}

// A dotted quad, in the single form the URL parser normalizes every IPv4 spelling to. Octal, hex,
// and integer spellings all arrive here already rewritten, so this one pattern covers them.
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/
// RFC 6761 reserves localhost and everything under it to the loopback interface. Spelled as two
// string comparisons rather than /^localhost$|\.localhost$/, whose unanchored second alternative
// makes the engine retry at every position of the host. This runs on every URL of every validation.
const LOOPBACK_NAME = 'localhost'
const isLoopbackName = (hostname: string): boolean =>
  hostname === LOOPBACK_NAME || hostname.endsWith(`.${LOOPBACK_NAME}`)

/**
 * Require a host that can plausibly be a public chart service: a DNS name, never an address literal
 * or a reserved loopback name. Address literals are rejected wholesale rather than range by range,
 * which keeps the private-range table in the one place that can act on it. A name still resolves at
 * request time, and a public name can resolve (or rebind) to a private address, so the consuming
 * server must check the resolved IP as well. This is the definition-time half of that pair.
 */
function assertPublicHost(hostname: string, label: string): void {
  // The URL parser brackets an IPv6 literal, so the opening bracket identifies the whole family.
  if (hostname.startsWith('[') || IPV4_LITERAL.test(hostname)) {
    throw new TypeError(`${label} must name a host, not an IP address literal`)
  }
  // The parser keeps a trailing dot and empty labels in a name, though it strips them from an
  // address. "localhost." resolves to loopback without matching the check below, and "h." names the
  // same host as "h", so the validated host has one spelling. The URL itself is still emitted as
  // written, so case and IDNA variants of the same host can reach a cache as different keys.
  if (hostname.startsWith('.') || hostname.endsWith('.') || hostname.includes('..')) {
    throw new TypeError(`${label} must not contain an empty label or a trailing dot`)
  }
  if (isLoopbackName(hostname)) throw new TypeError(`${label} must not name the loopback host`)
}

/**
 * Require the shape every outbound URL shares: https, a public host, and no credentials, port, or
 * fragment. It takes a parsed URL, so a caller resolving a redirect against a base checks the result.
 */
export function assertPublicHttpsUrlShape(url: URL, label: string): void {
  if (url.protocol !== 'https:') throw new TypeError(`${label} must use https`)
  if (url.hostname === '') throw new TypeError(`${label} must include a host`)
  if (url.username !== '' || url.password !== '') throw new TypeError(`${label} must not include credentials`)
  // The parser drops an explicit 443, so a surviving port is always a non-default one. A chart
  // service on an odd port is far more likely to be an internal target than a public upstream.
  if (url.port !== '') throw new TypeError(`${label} must not include a port`)
  // Already lowercase: the URL parser normalizes the host of a special scheme, so https never
  // reaches here mixed-case and a toLowerCase copy would be a per-tile allocation for nothing.
  assertPublicHost(url.hostname, label)
  if (url.hash !== '') throw new TypeError(`${label} must not include a fragment`)
}

// The URL parser skips any run of slashes and backslashes after a special scheme, so text whose host
// does not directly follow "https://" reads as a different authority than the parser finds.
const HOST_AFTER_SCHEME = /^https:\/\/[^/\\]/i

function parseHttpsUrl(value: unknown, label: string): URL {
  assertBoundedText(value, label, MAX_URL_BYTES)
  if (containsInvalidUrlCharacter(value))
    throw new TypeError(`${label} must not contain whitespace, control, or invisible characters`)
  // The parser reads a backslash as a slash, so anywhere in the text it gives one URL two spellings.
  if (value.includes('\\')) throw new TypeError(`${label} must not contain a backslash`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  assertPublicHttpsUrlShape(url, label)
  if (!HOST_AFTER_SCHEME.test(value)) throw new TypeError(`${label} must name its host directly after https://`)
  // A bare trailing "#" parses to an empty hash, so check the raw text as well.
  if (value.includes('#')) throw new TypeError(`${label} must not include a fragment`)
  return url
}

function assertCleanBaseUrl(value: unknown, label: string): asserts value is string {
  const url = parseHttpsUrl(value, label)
  // A bare trailing "?" parses to an empty search, so check the raw text as well. The typeof is
  // narrowing only: parseHttpsUrl proved value is a string, but its signature cannot carry that.
  if (url.search !== '' || (typeof value === 'string' && value.includes('?'))) {
    throw new TypeError(`${label} must not include query parameters`)
  }
}

function assertTemplate(value: unknown, label: string): void {
  assertBoundedText(value, label, MAX_URL_BYTES)
  // Literal, unlike parseHttpsUrl's parser-normalized scheme check, so a template keeps one spelling
  // of its scheme and a template on another scheme reports that before any token rule.
  if (!value.startsWith('https://')) throw new TypeError(`${label} must use https`)
  const expanded = substituteZXY(value, 0, 0, 0)
  // Any brace left over is an unsupported token, an empty pair, or an unclosed one, all of which
  // would reach the upstream verbatim.
  if (expanded.includes('{') || expanded.includes('}')) {
    throw new TypeError(`${label} contains an unsupported template token`)
  }
  // Whatever the raw text looks like, the host the parser finds must not move when the tile coordinate
  // does. Checked before the token counts, so a token in the host gets this more specific error.
  if (parseHttpsUrl(expanded, label).host !== parseHttpsUrl(substituteZXY(value, 1, 2, 3), label).host) {
    throw new TypeError(`${label} must not use template tokens in the host`)
  }
  for (const token of ['{z}', '{x}', '{y}']) {
    if (!value.includes(token)) throw new TypeError(`${label} is missing ${token}`)
    // A repeated token still expands to a valid URL, so it would silently mask a typo.
    if (value.indexOf(token) !== value.lastIndexOf(token)) {
      throw new TypeError(`${label} must contain ${token} exactly once`)
    }
  }
}

/**
 * Require that the only braces in a WMS or ArcGIS request are its one bbox token. upstreamTileTemplate
 * hands this request to MapLibre, which fills {ratio}, {quadkey}, and its other tokens anywhere in a
 * template, so a brace anywhere else, in the base or in a parameter value, would make the direct
 * request stop matching the proxied one.
 */
function assertOnlyBboxToken(request: string, label: string): void {
  const rest = request.replace(MAPLIBRE_BBOX_TOKEN, '')
  if (rest.includes('{') || rest.includes('}')) {
    throw new TypeError(`${label} must not contain braces other than the bbox token`)
  }
}

function assertQueryValue(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = false
): asserts value is string {
  assertBoundedText(value, label, maxBytes, allowEmpty)
  if (containsInvalidUrlCharacter(value) || INVALID_QUERY_VALUE_CHARACTER.test(value)) {
    throw new TypeError(`${label} must not contain whitespace, controls, invisibles, or the characters % & ? # + ; =`)
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
  // Already lowercase, as in parseHttpsUrl: the parser normalizes the host of a special scheme, which
  // is what makes the duplicate and authorization checks below case-insensitive.
  assertPublicHost(url.hostname, label)
  return url.hostname
}

/**
 * Require an absent or positive safe-integer field, the shape every optional count here uses. The id
 * and field name are passed separately so the sentence is only built on the throw path; this runs on
 * every source of every validation, and expandUpstreamUrl revalidates per tile.
 */
function assertOptionalPositiveInteger(value: unknown, id: string, field: string): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${id} ${field} must be a positive safe integer`)
  }
}

/**
 * Validate a snapshot in place. The checks below may read a field more than once, which only plain
 * data with nothing inherited makes safe, so every caller passes a snapshotSource copy.
 */
function assertValidSnapshot(source: unknown): asserts source is ChartSource {
  assertRecord(source, 'chart source')
  assertSourceId(source['id'])
  const id = source['id']
  assertBoundedText(source['title'], `${id} title`, MAX_TITLE_BYTES)
  assertAttribution(source['attribution'], `${id} attribution`)

  const tileSize = source['tileSize']
  if (tileSize !== 256 && tileSize !== 512) throw new RangeError(`${id} tileSize must be 256 or 512`)
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
    // Indexed rather than forEach, so no closure is allocated for a list that may hold 64 boxes and
    // is re-walked on every validation.
    for (let index = 0; index < coverage.length; index++) {
      const box = coverage[index]
      assertLngLatBbox(box, `${id} coverage[${index}]`)
      // A renderer hides the layer outside its display envelope, so a tile warmed beyond it is never
      // drawn. The tile helpers read coverage alone, so the containment is enforced here.
      if (bounds !== undefined && !withinBounds(box, bounds)) {
        throw new RangeError(`${id} coverage[${index}] must lie within its bounds`)
      }
    }
  }

  assertOptionalPositiveInteger(source['fallbackTileBytes'], id, 'fallbackTileBytes')
  assertOptionalPositiveInteger(source['maxAgeSeconds'], id, 'maxAgeSeconds')

  const group = source['group']
  if (group !== undefined) {
    assertRecord(group, `${id} group`)
    assertSourceId(group['id'], `${id} group id`)
    assertBoundedText(group['title'], `${id} group title`, MAX_TITLE_BYTES)
  }

  const upstream = source['upstream']
  assertRecord(upstream, `${id} upstream`)
  switch (upstream['mode']) {
    case 'wmts':
      assertTemplate(upstream['urlTemplate'], `${id} template`)
      break
    case 'xyz': {
      assertTemplate(upstream['urlTemplate'], `${id} template`)
      const tileJsonUrl = upstream['tileJsonUrl']
      if (tileJsonUrl !== undefined) parseHttpsUrl(tileJsonUrl, `${id} TileJSON URL`)
      break
    }
    case 'wms': {
      const base = upstream['base']
      const layers = upstream['layers']
      const styles = upstream['styles']
      const format = upstream['format']
      const transparent = upstream['transparent']
      assertCleanBaseUrl(base, `${id} WMS base`)
      assertQueryValue(layers, `${id} WMS layers`, MAX_WMS_LAYER_BYTES)
      assertQueryValue(styles, `${id} WMS styles`, MAX_WMS_STYLE_BYTES, true)
      assertWmsLayerLists(layers, styles, id)
      if (upstream['version'] !== WMS_VERSION) throw new TypeError(`${id} WMS version must be ${WMS_VERSION}`)
      assertQueryValue(format, `${id} WMS format`, MAX_WMS_FORMAT_BYTES)
      if (typeof transparent !== 'boolean') throw new TypeError(`${id} WMS transparent must be boolean`)
      const request = { mode: 'wms', base, layers, styles, version: WMS_VERSION, format, transparent } as const
      assertOnlyBboxToken(bboxRequestUrl(tileSize, request, MAPLIBRE_BBOX_TOKEN), `${id} WMS request`)
      break
    }
    case 'arcgis': {
      const base = upstream['base']
      assertCleanBaseUrl(base, `${id} ArcGIS base`)
      assertOnlyBboxToken(
        bboxRequestUrl(tileSize, { mode: 'arcgis', base }, MAPLIBRE_BBOX_TOKEN),
        `${id} ArcGIS request`
      )
      break
    }
    case 'style': {
      const styleUrl = parseHttpsUrl(upstream['styleUrl'], `${id} style URL`)
      const allowedHosts = upstream['allowedHosts']
      assertBoundedArray(allowedHosts, `${id} allowedHosts`, 'hosts', MAX_ALLOWED_HOSTS)
      const hosts = allowedHosts.map((host, index) => normalizedHost(host, `${id} allowedHosts[${index}]`))
      if (new Set(hosts).size !== hosts.length) throw new TypeError(`${id} allowedHosts must not contain duplicates`)
      if (!hosts.includes(styleUrl.hostname)) {
        throw new TypeError(`${id} allowedHosts must include ${styleUrl.hostname}`)
      }
      break
    }
    default:
      throw new TypeError(`${id} has an unknown upstream mode: ${describeValue(upstream['mode'])}`)
  }
}

/**
 * Validate and narrow a built-in or consumer-supplied source. Only the source's own enumerable
 * properties count, as for every helper that takes a source: a field it inherits is absent.
 *
 * @throws {TypeError | RangeError} When identity, bounded text, tile size, zooms, geography, the
 * optional byte and TTL counts, the group descriptor, HTTPS URLs, URL tokens, WMS parameters, or
 * style-host authorization are invalid.
 */
export function validateChartSource(source: unknown): asserts source is ChartSource {
  assertValidSnapshot(snapshotSource(source))
}

// Copy at most one entry past a list's bound, so an oversized list still fails its length check
// without the copy itself walking a hostile length. slice keeps holes, so the dense check still sees
// them.
const boundedCopy = (value: unknown, max: number): unknown =>
  Array.isArray(value) ? Array.prototype.slice.call(value, 0, max + 1) : value

/**
 * Copy an object's own enumerable properties onto a null prototype, invoking each getter once. With no
 * prototype behind it, the copy cannot inherit a field the original never carried.
 */
const ownCopy = (value: Record<string, unknown>): Record<string, unknown> => ({ __proto__: null, ...value })

/**
 * Copy a candidate source into plain data, reading every field exactly once, so validation and every
 * later use read the same values. A source built on accessors could otherwise hand the validator a
 * compliant field and the caller a different, unvalidated one. Only own enumerable properties are
 * copied, and the source, upstream, and group copies have null prototypes, so a field the candidate
 * inherits, from its own prototype or a polluted Object.prototype, is simply absent from the snapshot.
 * A source must therefore carry its fields as its own. Values that are not objects or arrays pass
 * through for the validator to reject with its own message.
 */
function snapshotSource(candidate: unknown): unknown {
  if (!isRecord(candidate)) return candidate
  const copy = ownCopy(candidate)
  const { upstream, bounds, coverage, group } = copy
  if (isRecord(upstream)) {
    const upstreamCopy = ownCopy(upstream)
    if ('allowedHosts' in upstreamCopy) {
      upstreamCopy['allowedHosts'] = boundedCopy(upstreamCopy['allowedHosts'], MAX_ALLOWED_HOSTS)
    }
    copy['upstream'] = upstreamCopy
  }
  if (bounds !== undefined) copy['bounds'] = boundedCopy(bounds, 4)
  if (Array.isArray(coverage)) {
    // map skips holes but keeps them in its result, so a sparse list still reaches the dense check.
    copy['coverage'] = (boundedCopy(coverage, MAX_COVERAGE_BOXES) as unknown[]).map((box) => boundedCopy(box, 4))
  }
  if (isRecord(group)) copy['group'] = ownCopy(group)
  return copy
}

/** A validated snapshot and the regions it covers, never handed outside the package. */
export interface PreparedSource {
  /**
   * A catalog source's snapshot is frozen as deeply as the catalog. A supplied source's is a per-call
   * copy nothing else holds, and freezing it would only slow the revalidation every call repeats.
   */
  readonly source: ChartSource
  /**
   * Its coverage, else its bounds, else the world, split at the antimeridian. A private copy rather
   * than frozen: V8 reads a frozen array's elements several times slower, and every coversPoint and
   * coversBbox call walks this list.
   */
  readonly regions: readonly LngLatBbox[]
}

const WORLD: LngLatBbox = [-180, -90, 180, 90]

/**
 * Prepared sources, keyed by each catalog source and by each validated snapshot itself, so a source
 * the package has already checked is neither copied nor validated again when it comes back in.
 */
const PREPARED = new WeakMap<object, PreparedSource>()

function prepare(snapshot: ChartSource): PreparedSource {
  // splitValidBbox returns fresh boxes, so no region shares an array with the frozen snapshot.
  const regions = (snapshot.coverage ?? [snapshot.bounds ?? WORLD]).flatMap(splitValidBbox)
  const prepared = Object.freeze({ source: snapshot, regions })
  PREPARED.set(snapshot, prepared)
  return prepared
}

/**
 * Return a source that is safe to read field by field, prepared for the tile helpers: the one already
 * registered for a catalog source or a returning snapshot, or a validated snapshot of anything else.
 * Internal to the package; the public entry points call it once and then read only what it returns.
 *
 * @throws {TypeError | RangeError} Under the same conditions as validateChartSource.
 */
export function checkedSource(candidate: unknown): PreparedSource {
  // WeakMap#get answers undefined for a primitive rather than throwing, so no type guard is needed first.
  const prepared = PREPARED.get(candidate as object)
  if (prepared !== undefined) return prepared
  const snapshot = snapshotSource(candidate)
  assertValidSnapshot(snapshot)
  return prepare(snapshot)
}

/**
 * Validate a catalog source and register its prepared snapshot under the source itself, so the
 * helpers take it without copying or validating it again. Internal to the package, for defineCatalog,
 * which freezes the snapshot with the rest of the catalog.
 */
export function registerCatalogSource(source: ChartSource): PreparedSource {
  const prepared = checkedSource(source)
  PREPARED.set(source, prepared)
  return prepared
}
