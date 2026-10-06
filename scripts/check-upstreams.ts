import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'
import {
  CHART_SOURCES,
  type ChartSource,
  chartSourceById,
  expandUpstreamUrl,
  type LngLatBbox,
  MAX_MERCATOR_LAT,
  tileForLngLat,
  webMercatorTileBounds
} from '../src/index.js'
import { substituteZXY, withoutTrailingSlashes } from '../src/request.js'
import { WMS_VERSION } from '../src/validate.js'
import { isRecord, object } from './records.mjs'
import { checkedPublicHttpsUrl } from './upstream-url.js'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_FETCH_ATTEMPTS = 2
/** Pause between fetch attempts, so a transient upstream error gets a moment to clear. */
const RETRY_DELAY_MS = 500
/** Redirect hops followed per request. Every hop is checked before it is requested. */
const MAX_REDIRECTS = 5
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** Bounds on the failure report handed to the tracking issue, which quotes it verbatim. */
const MAX_REPORTED_FAILURES = 40
const MAX_REPORTED_LINE_LENGTH = 400
/** How far a published WMTS matrix corner may sit from the projection origin before it is drift. */
const ORIGIN_TOLERANCE_METERS = 1
const USER_AGENT = 'signalk-chart-sources-upstream-monitor/1.0'
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  // Decode the HTML named and numeric character references too, such as the &#39; quotes around
  // GEBCO's requested acknowledgement, so text checks read the text a reader of the document sees.
  htmlEntities: true,
  // Capability documents are untrusted input: cap DOCTYPE entity definitions and expansions so a
  // hostile response cannot amplify past the bounded body size.
  processEntities: {
    enabled: true,
    maxEntityCount: 8,
    maxEntitySize: 256,
    maxTotalExpansions: 100_000,
    maxExpandedLength: MAX_RESPONSE_BYTES
  },
  maxNestedTags: 64
})

type RecordValue = Record<string, unknown>

function array(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value]
}

function strings(value: unknown): string[] {
  return array(value).filter((entry): entry is string => typeof entry === 'string')
}

function requiredString(value: unknown, label: string): string {
  assert.ok(typeof value === 'string', `${label} must be a string`)
  return value
}

function parseXml(bytes: Uint8Array, label: string): RecordValue {
  const parsed: unknown = XML.parse(new TextDecoder().decode(bytes))
  return object(parsed, label)
}

interface Fetched {
  readonly response: Response
  readonly bytes: Uint8Array
  /** The URL that answered, after every redirect hop passed the public-host check. */
  readonly finalUrl: URL
}

/**
 * Follow redirects by hand. Left to fetch, a redirect is followed before anything can inspect it, so
 * a check on the final URL only rejects a response from a host the request has already reached.
 */
async function fetchFollowingCheckedRedirects(url: string): Promise<{ response: Response; finalUrl: URL }> {
  let current = checkedPublicHttpsUrl(url)
  // One deadline for the whole chain, so a redirect loop cannot stretch it hop by hop.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  for (let hops = 0; ; hops++) {
    const response = await fetch(current, { headers: { 'user-agent': USER_AGENT }, redirect: 'manual', signal })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current }
    await response.body?.cancel()
    assert.ok(hops < MAX_REDIRECTS, `${url} redirected more than ${MAX_REDIRECTS} times`)
    const location = response.headers.get('location')
    assert.ok(location, `${current} redirected without a Location header`)
    current = checkedPublicHttpsUrl(location, current.href)
  }
}

async function fetchBytesOnce(url: string): Promise<Fetched> {
  const { response, finalUrl } = await fetchFollowingCheckedRedirects(url)
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`)
  // Number(null) is 0, which is finite, so testing the converted value alone would silently pass
  // every response that omits the header.
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number.isFinite(Number(declaredLength))) {
    assert.ok(Number(declaredLength) <= MAX_RESPONSE_BYTES, `${url} declares an oversized response`)
  }
  assert.ok(response.body, `${url} returned no response body`)
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      assert.ok(byteLength <= MAX_RESPONSE_BYTES, `${url} exceeded the response limit`)
      chunks.push(value)
    }
  } finally {
    // Release the socket when the cap trips or a read fails, instead of leaving the body dangling.
    await reader.cancel().catch(() => {})
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  assert.ok(bytes.byteLength > 0, `${url} returned an empty body`)
  return { response, bytes, finalUrl }
}

async function fetchBytes(url: string): Promise<Fetched> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchBytesOnce(url)
    } catch (error) {
      lastError = error
      if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }
  throw lastError
}

function expectedContentType(source: ChartSource): RegExp {
  if (source.upstream.mode === 'style') return /json/i
  if (source.upstream.mode === 'xyz' && source.upstream.urlTemplate.endsWith('.pbf')) {
    return /protobuf|octet-stream/i
  }
  if (source.upstream.mode === 'xyz' && source.upstream.urlTemplate.endsWith('.webp')) {
    return /image\/webp/i
  }
  return /image\//i
}

function assertPngDimensions(source: ChartSource, contentType: string, bytes: Uint8Array): void {
  if (!/image\/png/i.test(contentType)) return
  assert.ok(bytes.byteLength >= 24, `${source.id} returned a truncated PNG`)
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    `${source.id} returned invalid PNG data`
  )
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(16), source.tileSize, `${source.id} PNG width drifted`)
  assert.equal(view.getUint32(20), source.tileSize, `${source.id} PNG height drifted`)
}

function bboxCenter(bbox: LngLatBbox): readonly [number, number] {
  const [west, south, east, north] = bbox
  const span = west < east ? east - west : 360 - west + east
  const longitude = ((((west + span / 2 + 180) % 360) + 360) % 360) - 180
  return [longitude, (south + north) / 2]
}

/** The whole Web Mercator square, for a source that declares neither bounds nor coverage. */
const WORLD_BBOX: LngLatBbox = [-180, -MAX_MERCATOR_LAT, 180, MAX_MERCATOR_LAT]

function representativeTile(source: ChartSource): readonly [number, number, number] {
  const bbox = source.coverage?.[0] ?? source.bounds ?? WORLD_BBOX
  const [longitude, latitude] = bboxCenter(bbox)
  const z = Math.min(source.maxzoom, Math.max(source.minzoom, 4))
  const { x, y } = tileForLngLat(longitude, latitude, z)
  return [z, x, y]
}

function collectStyleReferences(style: RecordValue): {
  resources: string[]
  tileJson: string[]
  imports: string[]
} {
  const resources: string[] = []
  const tileJson: string[] = []
  const imports: string[] = []
  // sprite is a string in the classic form and an array of {id, url} since the v5 style spec, so a
  // string-only read would silently miss a whole host.
  if (typeof style['sprite'] === 'string') resources.push(style['sprite'])
  for (const sprite of array(style['sprite'])) {
    if (isRecord(sprite) && typeof sprite['url'] === 'string') resources.push(sprite['url'])
  }
  if (typeof style['glyphs'] === 'string') resources.push(style['glyphs'])

  for (const imported of array(style['imports'])) {
    if (isRecord(imported) && typeof imported['url'] === 'string') imports.push(imported['url'])
  }
  if (isRecord(style['sources'])) {
    for (const value of Object.values(style['sources'])) {
      if (!isRecord(value)) continue
      if (typeof value['url'] === 'string') tileJson.push(value['url'])
      // A geojson source names its data by URL, which is another host the allowlist must cover.
      if (typeof value['data'] === 'string') resources.push(value['data'])
      resources.push(...strings(value['tiles']))
    }
  }
  return { resources, tileJson, imports }
}

interface TileJsonDocument {
  readonly url: URL
  readonly json: RecordValue
}

/**
 * Walk a style's transitive graph, returning every host it reaches and every TileJSON it fetched on
 * the way, so the caller can check the published metadata without fetching it twice.
 */
async function discoverStyleGraph(styleUrl: string): Promise<{ hosts: Set<string>; tileJson: TileJsonDocument[] }> {
  const hosts = new Set<string>()
  const tileJsonDocuments: TileJsonDocument[] = []
  const visitedStyles = new Set<string>()
  const visitedTileJson = new Set<string>()

  const inspectTileJson = async (candidate: string, base: string): Promise<void> => {
    const url = checkedPublicHttpsUrl(candidate, base)
    hosts.add(url.hostname.toLowerCase())
    if (visitedTileJson.has(url.href)) return
    visitedTileJson.add(url.href)
    const { json: tileJson, finalUrl } = await fetchJson(url.href, 'TileJSON')
    tileJsonDocuments.push({ url, json: tileJson })
    hosts.add(finalUrl.hostname.toLowerCase())
    for (const tile of strings(tileJson['tiles'])) {
      hosts.add(checkedPublicHttpsUrl(tile, finalUrl.href).hostname.toLowerCase())
    }
  }

  const inspectStyle = async (candidate: string, base?: string): Promise<void> => {
    const url = checkedPublicHttpsUrl(candidate, base)
    hosts.add(url.hostname.toLowerCase())
    if (visitedStyles.has(url.href)) return
    visitedStyles.add(url.href)
    const { json: style, finalUrl } = await fetchJson(url.href, 'style')
    hosts.add(finalUrl.hostname.toLowerCase())
    const references = collectStyleReferences(style)
    for (const resource of references.resources) {
      hosts.add(checkedPublicHttpsUrl(resource, finalUrl.href).hostname.toLowerCase())
    }
    await Promise.all([
      ...references.tileJson.map((tileJson) => inspectTileJson(tileJson, finalUrl.href)),
      ...references.imports.map((imported) => inspectStyle(imported, finalUrl.href))
    ])
  }

  await inspectStyle(styleUrl)
  return { hosts, tileJson: tileJsonDocuments }
}

async function checkSource(source: ChartSource): Promise<void> {
  if (source.upstream.mode === 'style') {
    const graph = await discoverStyleGraph(source.upstream.styleUrl)
    const discovered = [...graph.hosts].sort()
    const allowed = [...new Set(source.upstream.allowedHosts.map((host) => host.toLowerCase()))].sort()
    assert.deepEqual(allowed, discovered, `${source.id} allowedHosts drifted from its style graph`)
    assert.ok(graph.tileJson.length > 0, `${source.id} style graph no longer names a TileJSON`)
    // A style carries the credit and the native zoom of its vector data in the TileJSON it points at,
    // not in the style document, so the host check alone would let both drift unnoticed.
    for (const { url, json } of graph.tileJson) {
      assertTileJsonMetadata(source, url.href, json, source.vectorMaxzoom ?? source.maxzoom)
    }
    console.log(
      `${source.id}: ${discovered.length} authorized style host(s), attribution matches ` +
        graph.tileJson.map(({ url }) => url.href).join(', ')
    )
    return
  }

  const [z, x, y] = representativeTile(source)
  const url = expandUpstreamUrl(source, z, x, y)
  const { response, bytes } = await fetchBytes(url)
  const contentType = response.headers.get('content-type') ?? ''
  assert.match(contentType, expectedContentType(source), `${source.id} content type drifted`)
  assertPngDimensions(source, contentType, bytes)
  console.log(`${source.id}: z${z}/${x}/${y}, HTTP ${response.status}, ${contentType}, ${bytes.byteLength} bytes`)
}

/**
 * Fetch and parse a JSON document. Style documents, TileJSON, ArcGIS service metadata, and the
 * attribution check all need the same steps, and one helper keeps them from drifting apart.
 */
async function fetchJson(url: string, label: string): Promise<{ json: RecordValue; finalUrl: URL }> {
  const { response, bytes, finalUrl } = await fetchBytes(url)
  assert.match(response.headers.get('content-type') ?? '', /json/i, `${finalUrl} content type drifted`)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  return { json: object(parsed, `${finalUrl} ${label}`), finalUrl }
}

function assertTileJsonMetadata(source: ChartSource, url: string, tileJson: RecordValue, maxzoom: number): void {
  const published = requiredString(tileJson['attribution'], `${source.id} upstream attribution`)
  // Exact, not a substring or a trim. The catalog's rule is that attribution is transcribed, and a
  // service that rewords its credit line has changed what the webapp is obliged to display.
  assert.equal(
    source.attribution,
    published,
    `${source.id} attribution drifted from ${url}. Transcribe the upstream value into registry.ts and ` +
      `Binnacle's copy together.`
  )
  const publishedMaxzoom = tileJson['maxzoom']
  if (publishedMaxzoom !== undefined) {
    assert.equal(Number(publishedMaxzoom), maxzoom, `${source.id} maxzoom drifted from ${url}`)
  }
}

/**
 * Check an XYZ source against the TileJSON its service publishes. A tile template carries no
 * metadata of its own, so without this the transcribed attribution is checked by nothing: Seascape
 * shortened its credit line and the monitor stayed green through it. The URL lives on the source
 * rather than in a table here, because the catalog is the only place upstream data belongs.
 */
async function checkTileJsonAttribution(source: ChartSource, tileJsonUrl: string): Promise<void> {
  const { json: tileJson } = await fetchJson(tileJsonUrl, 'TileJSON')
  assertTileJsonMetadata(source, tileJsonUrl, tileJson, source.maxzoom)
  console.log(`${source.id}: attribution matches ${tileJsonUrl}`)
}

function collectWmsLayers(layer: unknown, layers = new Map<string, RecordValue>()): Map<string, RecordValue> {
  for (const entry of array(layer)) {
    if (!isRecord(entry)) continue
    if (typeof entry['Name'] === 'string') layers.set(entry['Name'], entry)
    collectWmsLayers(entry['Layer'], layers)
  }
  return layers
}

/** How far a catalog box may sit outside an advertised envelope before it counts as drift. */
const ENVELOPE_TOLERANCE_DEGREES = 0.5

type EnvelopeEdges = readonly [west: string, south: string, east: string, north: string]

const WMS_ENVELOPE_EDGES: EnvelopeEdges = [
  'westBoundLongitude',
  'southBoundLatitude',
  'eastBoundLongitude',
  'northBoundLatitude'
]
const ARCGIS_EXTENT_EDGES: EnvelopeEdges = ['xmin', 'ymin', 'xmax', 'ymax']

/** A coordinate published as a number or a numeric string, and NaN for anything else. */
function coordinate(value: unknown): number {
  return typeof value === 'number' || (typeof value === 'string' && value !== '') ? Number(value) : Number.NaN
}

/**
 * An advertised envelope as a bbox, or null when it is missing or any edge is not a finite number. The
 * edges default to a WMS EX_GeographicBoundingBox.
 */
function envelopeOf(box: unknown, [west, south, east, north] = WMS_ENVELOPE_EDGES): LngLatBbox | null {
  if (!isRecord(box)) return null
  const envelope: LngLatBbox = [
    coordinate(box[west]),
    coordinate(box[south]),
    coordinate(box[east]),
    coordinate(box[north])
  ]
  return envelope.every(Number.isFinite) ? envelope : null
}

/**
 * The upstream envelope a coverage list was derived against. A WMS source reads the
 * EX_GeographicBoundingBox of the named layer, or of the root layer when it names none, and an
 * ArcGIS source reads its service fullExtent.
 */
interface CoverageDerivation {
  readonly envelope: LngLatBbox
  readonly layer?: string
}

/** Only parse noise: any real move of a derivation envelope means re-deriving the coverage. */
const DERIVATION_TOLERANCE_DEGREES = 1e-6

// The NOAA ENC bounds are the service envelope by definition, and the ENC product catalog extremes its
// coverage came from match them, so the catalog's own copy is the one compared.
const noaaEncBounds = chartSourceById('depth-noaa-enc')?.bounds
assert.ok(noaaEncBounds, 'the catalog no longer carries the NOAA ENC bounds its coverage was derived against')
const NOAA_ENC_DERIVATION: CoverageDerivation = { envelope: noaaEncBounds }
// The two below differ from their sources' bounds, so each is recorded at the precision its service
// publishes, as read 2026-10-05.
/** The advertised extent of the DTM layer, which the EMODnet coverage was sampled across. */
const EMODNET_DTM_DERIVATION: CoverageDerivation = {
  layer: 'emodnet:mean_multicolour',
  envelope: [-73.125, 5.625, 45, 90]
}
/** The MPA inventory fullExtent, which bounds the sub-layer geometry its coverage was derived from. */
const NOAA_MPA_DERIVATION: CoverageDerivation = { envelope: [-180, -15.386142388, 180, 74.707417538] }

/**
 * Every catalog source that carries coverage, keyed by id, with the envelope its coverage was derived
 * against. Coverage is derived once from upstream data inside that envelope, so the envelope moving
 * at all is the signal to re-derive it, which a containment check on the bounds would not catch.
 */
const COVERAGE_DERIVATIONS: Readonly<Record<string, CoverageDerivation>> = {
  'depth-noaa-enc': NOAA_ENC_DERIVATION,
  'depth-noaa-enc-quality': NOAA_ENC_DERIVATION,
  'depth-emodnet': EMODNET_DTM_DERIVATION,
  'depth-emodnet-quality': EMODNET_DTM_DERIVATION,
  'depth-emodnet-contours': EMODNET_DTM_DERIVATION,
  'mpa-noaa': NOAA_MPA_DERIVATION
}

/** Compare the envelope a source's coverage was derived against with what the upstream publishes now. */
function assertCoverageDerivation(
  source: ChartSource,
  derivation: CoverageDerivation,
  published: LngLatBbox | null,
  label: string
): void {
  assert.ok(published, `${source.id} upstream no longer publishes the ${label} its coverage was derived from`)
  assert.ok(
    published.every(
      (edge, index) => Math.abs(edge - (derivation.envelope[index] ?? Number.NaN)) <= DERIVATION_TOLERANCE_DEGREES
    ),
    `${source.id} coverage was derived from the ${label} ${JSON.stringify(derivation.envelope)}, which now reads ` +
      `${JSON.stringify(published)}; re-derive it`
  )
}

function wmsRoot(document: RecordValue, label: string): RecordValue {
  return object(document['WMS_Capabilities'] ?? document['WMT_MS_Capabilities'], label)
}

function wmsCapabilitiesUrl(base: string): string {
  return `${base}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=${WMS_VERSION}`
}

interface WmsCapabilities {
  readonly service: RecordValue
  readonly rootLayer: RecordValue
  readonly layers: Map<string, RecordValue>
  readonly formats: string[]
}

const wmsCapabilityRequests = new Map<string, Promise<WmsCapabilities>>()

/** One fetch per service, shared by its own check and the GEBCO attribution check. */
function wmsCapabilities(base: string): Promise<WmsCapabilities> {
  let request = wmsCapabilityRequests.get(base)
  if (!request) {
    request = (async () => {
      const { bytes } = await fetchBytes(wmsCapabilitiesUrl(base))
      const root = wmsRoot(parseXml(bytes, `${base} capabilities`), `${base} WMS root`)
      assert.equal(root['@_version'], WMS_VERSION, `${base} WMS version drifted`)
      const service = object(root['Service'], `${base} Service`)
      const capability = object(root['Capability'], `${base} Capability`)
      const getMap = object(object(capability['Request'], `${base} Request`)['GetMap'], `${base} GetMap`)
      const rootLayer = object(capability['Layer'], `${base} root Layer`)
      return { service, rootLayer, layers: collectWmsLayers(rootLayer), formats: strings(getMap['Format']) }
    })()
    wmsCapabilityRequests.set(base, request)
  }
  return request
}

/**
 * The titles behind the NOAA ENC service's numbered layers. A number says nothing about content, so
 * a renumbering upstream would silently move the data-quality facet onto other layers. This is a
 * monitor-side expectation rather than catalog data: the catalog requests these layers by number.
 */
const EXPECTED_WMS_LAYER_TITLES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'depth-noaa-enc': {
    '0': 'Information about the chart display',
    '1': 'Natural and man-made features, port features',
    '2': 'Depths, currents, etc',
    '3': 'Seabed, obstructions, pipelines',
    '4': 'Traffic routes',
    '5': 'Special areas',
    '6': 'Buoys, beacons, lights, fog signals, radar',
    '7': 'Services and small craft facilities',
    '10': 'Additional chart information'
  },
  'depth-noaa-enc-quality': {
    '8': 'Data quality',
    '9': 'Low accuracy'
  }
}

function checkWmsSource(source: ChartSource, capabilities: WmsCapabilities): void {
  assert.equal(source.upstream.mode, 'wms')
  const { layers, formats, rootLayer } = capabilities
  assert.ok(formats.includes(source.upstream.format), `${source.id} format ${source.upstream.format} is unavailable`)
  const requestedLayers = source.upstream.layers.split(',')
  const configuredLayers = requestedLayers.map((name) => {
    const configured = layers.get(name)
    assert.ok(configured, `${source.id} layer ${name} is unavailable`)
    return configured
  })
  // STYLES pairs with LAYERS by position, so a style must be offered by the layer it is requested
  // for. Searching every layer's styles would pass a request the server rejects.
  if (source.upstream.styles !== '') {
    // The list lengths already agree: validateChartSource enforces the pairing when the catalog is
    // built, so this only has to check availability against the live capabilities.
    const requestedStyles = source.upstream.styles.split(',')
    requestedStyles.forEach((style, index) => {
      if (style === '') return
      const layer = configuredLayers[index]
      const availableStyles = array(layer?.['Style'])
        .filter(isRecord)
        .map((entry) => entry['Name'])
        .filter((name): name is string => typeof name === 'string')
      assert.ok(
        availableStyles.includes(style),
        `${source.id} style ${style} is unavailable on layer ${requestedLayers[index]}`
      )
    })
  }

  const expectedTitles = EXPECTED_WMS_LAYER_TITLES[source.id]
  if (expectedTitles) {
    assert.deepEqual(
      Object.fromEntries(requestedLayers.map((name, index) => [name, configuredLayers[index]?.['Title']])),
      expectedTitles,
      `${source.id} layers no longer carry the expected content, or its title expectations no longer match ` +
        'its configured layers'
    )
  }

  // A source that declares bounds is checked against the envelope its own layer advertises.
  // Containment rather than equality, because some bounds are deliberately narrower: the EMODnet ones
  // come from sampling where the grid actually has data, and the advertised box is the tiling extent.
  // A catalog box reaching outside the advertised one is always wrong, either a bad transcription or
  // an upstream that shrank.
  const advertised = source.bounds
    ? envelopeOf(layers.get(requestedLayers[0] ?? '')?.['EX_GeographicBoundingBox'])
    : null
  if (source.bounds && advertised) {
    const [west, south, east, north] = source.bounds
    const [advWest, advSouth, advEast, advNorth] = advertised
    assert.ok(
      west >= advWest - ENVELOPE_TOLERANCE_DEGREES &&
        south >= advSouth - ENVELOPE_TOLERANCE_DEGREES &&
        east <= advEast + ENVELOPE_TOLERANCE_DEGREES &&
        north <= advNorth + ENVELOPE_TOLERANCE_DEGREES,
      `${source.id} bounds ${JSON.stringify(source.bounds)} reach outside the advertised ` +
        `envelope ${JSON.stringify(advertised)}`
    )
  }

  const derivation = COVERAGE_DERIVATIONS[source.id]
  if (derivation) {
    const layer = derivation.layer === undefined ? rootLayer : layers.get(derivation.layer)
    const published = envelopeOf(layer?.['EX_GeographicBoundingBox'])
    assertCoverageDerivation(source, derivation, published, `${derivation.layer ?? 'service'} envelope`)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Check one WMS service and every catalog source it serves. Each source is checked on its own and
 * every failure is reported, so one drifted layer cannot hide drift in the rest of the service.
 */
async function checkWmsService(base: string, sources: readonly ChartSource[]): Promise<void> {
  const capabilities = await wmsCapabilities(base)
  const supportedCrs = new Set(strings(capabilities.rootLayer['CRS']))
  assert.ok(supportedCrs.has('EPSG:3857'), `${base} no longer advertises EPSG:3857`)
  const failures: string[] = []
  for (const source of sources) {
    try {
      checkWmsSource(source, capabilities)
    } catch (error) {
      failures.push(errorMessage(error))
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
  console.log(`${base}: WMS capabilities verified for ${sources.length} source(s)`)
}

/** The sentence in GEBCO's capabilities abstract that quotes the acknowledgement it asks for. */
const GEBCO_ACKNOWLEDGEMENT = /be of the form '([^']+)'/g

/**
 * Check every source on the GEBCO service against the acknowledgement GEBCO requests, verbatim. The
 * grid is re-released yearly and its DOI changes with it, so a half-edited credit would otherwise
 * pass on the grid name alone.
 */
async function checkGebcoAttribution(base: string, sources: readonly ChartSource[]): Promise<void> {
  const { service, rootLayer } = await wmsCapabilities(base)
  // GEBCO repeats its abstract on the root layer, so both copies are read and must agree.
  const text = strings([service['Abstract'], rootLayer['Abstract']]).join('\n')
  const servedGrid = /currently provides access to the (GEBCO_\d{4}) Grid/i.exec(text)?.[1]
  assert.ok(servedGrid, 'GEBCO capabilities no longer declare the served grid version')
  const requested = [...new Set([...text.matchAll(GEBCO_ACKNOWLEDGEMENT)].map((match) => match[1] ?? ''))]
  assert.ok(
    requested.length > 0,
    `GEBCO capabilities no longer quote the acknowledgement they request (no "be of the form '...'" sentence)`
  )
  assert.equal(
    requested.length,
    1,
    `GEBCO capabilities quote ${requested.length} different acknowledgements: ${JSON.stringify(requested)}`
  )
  const acknowledgement = requested[0] ?? ''
  assert.ok(
    acknowledgement.includes(`${servedGrid} Grid`),
    `GEBCO requests ${JSON.stringify(acknowledgement)}, which does not name the served ${servedGrid}`
  )
  for (const source of sources) {
    assert.equal(
      source.attribution,
      acknowledgement,
      `${source.id} attribution drifted from the acknowledgement GEBCO requests for ${servedGrid}`
    )
  }
  console.log(`GEBCO attribution matches ${servedGrid} for ${sources.length} source(s)`)
}

/**
 * Check that the EMODnet bathymetry sources credit the DTM release the service currently serves.
 *
 * EMODnet publishes a new DTM every two years under the same layer names, so nothing in a layer
 * request changes when a release lands; only the credit goes stale. Two signals in the capabilities
 * document name the current release, and both must agree with the year the attribution names:
 *
 * - The time dimension of emodnet:quality_index lists one survey index per release and defaults to
 *   the current one, stamped at the end of its release year (2024-12-31T23:00:00Z today). Its year
 *   is the current release.
 * - Superseded releases stay available as archived layers named emodnet:mean_<year>, such as
 *   emodnet:mean_2022. An archive layer for the attributed year, or a later one, means the attributed
 *   release has been superseded, even if the time dimension changes shape.
 *
 * The page-level release notes on emodnet.ec.europa.eu would be more direct, but they are prose on a
 * website rather than service metadata, so the capabilities document is the signal to rely on.
 */
async function checkEmodnetRelease(base: string, sources: readonly ChartSource[]): Promise<void> {
  const { layers } = await wmsCapabilities(base)
  const qualityIndex = layers.get('emodnet:quality_index')
  assert.ok(qualityIndex, 'EMODnet no longer publishes emodnet:quality_index, the release signal')
  const time = array(qualityIndex['Dimension'])
    .filter(isRecord)
    .find((dimension) => dimension['@_name'] === 'time')
  const defaultTime = typeof time?.['@_default'] === 'string' ? time['@_default'] : ''
  const servedYear = /^(\d{4})-/.exec(defaultTime)?.[1]
  assert.ok(servedYear, `emodnet:quality_index no longer defaults its time dimension to a release date`)
  const archivedYears = [...layers.keys()]
    .map((name) => /^emodnet:mean_(\d{4})$/.exec(name)?.[1])
    .filter((year): year is string => year !== undefined)
    .map(Number)

  for (const source of sources) {
    const years = [...source.attribution.matchAll(/(?:\(|\bDTM )(\d{4})\)/g)].map((match) => match[1])
    assert.ok(years.length > 0, `${source.id} attribution no longer names a DTM release year`)
    for (const year of years) {
      assert.equal(year, servedYear, `${source.id} credits DTM ${year}, but EMODnet serves the ${servedYear} release`)
      assert.ok(
        archivedYears.every((archived) => archived < Number(year)),
        `${source.id} credits DTM ${year}, which EMODnet has archived as emodnet:mean_${year} or superseded`
      )
    }
  }
  console.log(`EMODnet attribution matches the DTM ${servedYear} release for ${sources.length} source(s)`)
}

/**
 * The sub-layers the ArcGIS MapServer behind each arcgis source published when the catalog entry was
 * derived. The mpa-noaa coverage was derived from these eight, so a change means re-deriving it.
 */
const EXPECTED_ARCGIS_LAYERS: Readonly<Record<string, readonly string[]>> = {
  'mpa-noaa': [
    'MPA_States_inventory',
    'MPA_NERRS_inventory',
    'MPA_BOEM_inventory',
    'MPA_MNM_inventory',
    'MPA_NMS_inventory',
    'MPA_NPS_inventory',
    'MPA_NWRS_inventory',
    'MPA_NFS_inventory'
  ]
}

function commaList(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map((entry) => entry.trim()) : []
}

async function checkArcgisService(source: ChartSource): Promise<void> {
  assert.equal(source.upstream.mode, 'arcgis')
  const expectedLayers = EXPECTED_ARCGIS_LAYERS[source.id]
  assert.ok(expectedLayers, `${source.id} has no ArcGIS sub-layer expectation in the upstream monitor`)
  const url = `${withoutTrailingSlashes(source.upstream.base)}?f=json`
  const { json: service } = await fetchJson(url, 'ArcGIS service')
  // ArcGIS reports a failure as an error object inside a successful response.
  assert.ok(service['error'] === undefined || service['error'] === null, `${source.id} service reported an error`)
  assert.ok(commaList(service['capabilities']).includes('Map'), `${source.id} service no longer exports maps`)
  assert.ok(
    commaList(service['supportedImageFormatTypes']).includes('PNG32'),
    `${source.id} service no longer offers the PNG32 format expandUpstreamUrl requests`
  )
  const layers = array(service['layers'])
    .filter(isRecord)
    .map((layer) => layer['name'])
  assert.deepEqual(layers, expectedLayers, `${source.id} sub-layers drifted; re-derive its coverage`)
  const extent = object(service['fullExtent'], `${source.id} fullExtent`)
  const reference = object(extent['spatialReference'], `${source.id} fullExtent spatialReference`)
  assert.equal(reference['latestWkid'] ?? reference['wkid'], 4326, `${source.id} fullExtent left EPSG:4326`)
  const derivation = COVERAGE_DERIVATIONS[source.id]
  if (derivation) assertCoverageDerivation(source, derivation, envelopeOf(extent, ARCGIS_EXTENT_EDGES), 'fullExtent')
  console.log(`${source.id}: ArcGIS service verified with ${layers.length} sub-layers`)
}

/** The template with its tokens zeroed: a valid URL whose query still names the configured layer. */
function zeroedTemplateUrl(template: string): URL {
  return checkedPublicHttpsUrl(substituteZXY(template, 0, 0, 0))
}

function wmtsCapabilitiesUrl(configured: URL): string {
  const url = new URL(configured)
  url.search = ''
  url.searchParams.set('SERVICE', 'WMTS')
  url.searchParams.set('VERSION', '1.0.0')
  url.searchParams.set('REQUEST', 'GetCapabilities')
  return url.href
}

async function checkWmtsCapabilities(source: ChartSource): Promise<void> {
  assert.equal(source.upstream.mode, 'wmts')
  const configured = zeroedTemplateUrl(source.upstream.urlTemplate)
  const { bytes } = await fetchBytes(wmtsCapabilitiesUrl(configured))
  const document = parseXml(bytes, `${source.id} capabilities`)
  const root = object(document['Capabilities'], `${source.id} WMTS root`)
  assert.equal(root['@_version'], '1.0.0', `${source.id} WMTS version drifted`)
  const contents = object(root['Contents'], `${source.id} WMTS contents`)
  const layerName = requiredString(configured.searchParams.get('LAYER'), `${source.id} LAYER`)
  const layer = array(contents['Layer'])
    .filter(isRecord)
    .find((entry) => entry['Identifier'] === layerName)
  assert.ok(layer, `${source.id} layer ${layerName} is unavailable`)

  const format = requiredString(configured.searchParams.get('FORMAT'), `${source.id} FORMAT`)
  assert.ok(strings(layer['Format']).includes(format), `${source.id} format ${format} is unavailable`)
  const matrixSetName = requiredString(configured.searchParams.get('TILEMATRIXSET'), `${source.id} TILEMATRIXSET`)
  const links = array(layer['TileMatrixSetLink']).filter(isRecord)
  assert.ok(
    links.some((entry) => entry['TileMatrixSet'] === matrixSetName),
    `${source.id} matrix set link drifted`
  )

  const configuredStyle = configured.searchParams.get('STYLE') ?? ''
  const styles = array(layer['Style']).filter(isRecord)
  if (configuredStyle === '') {
    assert.ok(
      styles.some((entry) => entry['@_isDefault'] === 'true'),
      `${source.id} no longer has a default style`
    )
  } else {
    assert.ok(
      styles.some((entry) => entry['Identifier'] === configuredStyle),
      `${source.id} style ${configuredStyle} is unavailable`
    )
  }

  const matrixSet = array(contents['TileMatrixSet'])
    .filter(isRecord)
    .find((entry) => entry['Identifier'] === matrixSetName)
  assert.ok(matrixSet, `${source.id} matrix set ${matrixSetName} is unavailable`)
  assert.match(requiredString(matrixSet['SupportedCRS'], `${source.id} SupportedCRS`), /EPSG(?::|::)3857$/)
  const matrices = new Map(
    array(matrixSet['TileMatrix'])
      .filter(isRecord)
      .map((entry) => [entry['Identifier'], entry])
  )
  for (let z = source.minzoom; z <= source.maxzoom; z++) {
    const identifier = `${matrixSetName}:${z}`
    const matrix = matrices.get(identifier)
    assert.ok(matrix, `${source.id} matrix ${identifier} is unavailable`)
    assert.equal(Number(matrix['TileWidth']), source.tileSize, `${identifier} width drifted`)
    assert.equal(Number(matrix['TileHeight']), source.tileSize, `${identifier} height drifted`)
    assert.equal(Number(matrix['MatrixWidth']), 2 ** z, `${identifier} matrix width drifted`)
    assert.equal(Number(matrix['MatrixHeight']), 2 ** z, `${identifier} matrix height drifted`)
    // webMercatorTileBounds assumes the projection origin at the top-left corner of z0. A matrix set
    // anchored anywhere else would return correctly named tiles covering the wrong ground. Services
    // publish this corner rounded, so compare within a meter: a matrix set anchored elsewhere is
    // off by degrees of longitude, never by centimeters.
    const [cornerX, cornerY] = requiredString(matrix['TopLeftCorner'], `${identifier} TopLeftCorner`)
      .split(/\s+/)
      .map(Number)
    const [expectedMinX, , , expectedMaxY] = webMercatorTileBounds(0, 0, 0)
    assert.ok(
      cornerX !== undefined && Math.abs(cornerX - expectedMinX) < ORIGIN_TOLERANCE_METERS,
      `${identifier} top-left x ${cornerX} drifted from the projection origin ${expectedMinX}`
    )
    assert.ok(
      cornerY !== undefined && Math.abs(cornerY - expectedMaxY) < ORIGIN_TOLERANCE_METERS,
      `${identifier} top-left y ${cornerY} drifted from the projection origin ${expectedMaxY}`
    )
  }
  console.log(`${source.id}: WMTS capabilities verified through z${source.maxzoom}`)
}

const wmsServices = new Map<string, ChartSource[]>()
for (const source of CHART_SOURCES) {
  if (source.upstream.mode !== 'wms') continue
  wmsServices.set(source.upstream.base, [...(wmsServices.get(source.upstream.base) ?? []), source])
}

/** The service base of a catalog WMS source, which a service-wide check keys its sources by. */
function catalogWmsBase(id: string): string {
  const source = chartSourceById(id)
  assert.ok(source?.upstream.mode === 'wms', `the catalog no longer carries the ${id} WMS source`)
  return source.upstream.base
}
const gebcoBase = catalogWmsBase('depth-gebco')
const emodnetBase = catalogWmsBase('depth-emodnet')

// A coverage list with no derivation entry would go unchecked when the envelope it came from moves,
// and only WMS and ArcGIS sources publish an envelope to compare.
const sourcesWithCoverage = CHART_SOURCES.filter((source) => source.coverage !== undefined)
assert.deepEqual(
  sourcesWithCoverage.map(({ id }) => id).sort(),
  Object.keys(COVERAGE_DERIVATIONS).sort(),
  'every catalog source with coverage needs exactly one COVERAGE_DERIVATIONS entry in the upstream monitor'
)
for (const source of sourcesWithCoverage) {
  assert.ok(
    source.upstream.mode === 'wms' || source.upstream.mode === 'arcgis',
    `${source.id} carries coverage, but the upstream monitor reads derivation envelopes only from WMS and ArcGIS`
  )
}

// One labeled check per source, per WMS service, and per capability document, so a failure names
// exactly what drifted and never hides another one behind it.
const checks: ReadonlyArray<readonly [string, Promise<void>]> = [
  ...CHART_SOURCES.map((source) => [source.id, checkSource(source)] as const),
  ...[...wmsServices].map(([base, sources]) => [`${base} WMS capabilities`, checkWmsService(base, sources)] as const),
  ['GEBCO attribution', checkGebcoAttribution(gebcoBase, wmsServices.get(gebcoBase) ?? [])] as const,
  ['EMODnet bathymetry release', checkEmodnetRelease(emodnetBase, wmsServices.get(emodnetBase) ?? [])] as const,
  ...CHART_SOURCES.filter((source) => source.upstream.mode === 'wmts').map(
    (source) => [`${source.id} WMTS capabilities`, checkWmtsCapabilities(source)] as const
  ),
  ...CHART_SOURCES.filter((source) => source.upstream.mode === 'arcgis').map(
    (source) => [`${source.id} ArcGIS service`, checkArcgisService(source)] as const
  ),
  ...CHART_SOURCES.flatMap((source) =>
    source.upstream.mode === 'xyz' && source.upstream.tileJsonUrl !== undefined
      ? [[`${source.id} attribution`, checkTileJsonAttribution(source, source.upstream.tileJsonUrl)] as const]
      : []
  )
]

// Report every drifted check from one run. Awaiting them together and rethrowing the first would
// hide the rest, so a maintainer would fix one source and rediscover the others a week later. Each
// check carries its own label, which keeps the report from depending on positional correlation.
const outcomes = await Promise.all(
  checks.map(async ([label, promise]) => {
    try {
      await promise
      return null
    } catch (error) {
      return `${label}: ${errorMessage(error)}`
    }
  })
)

/** One failure on one bounded line, because the tracking issue quotes the report verbatim. */
function reportLine(failure: string): string {
  const line = failure.replace(/\s+/g, ' ')
  return line.length > MAX_REPORTED_LINE_LENGTH ? `${line.slice(0, MAX_REPORTED_LINE_LENGTH - 3)}...` : line
}

/** A Markdown fence longer than any backtick run in the text, so the text cannot close it early. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(2, ...[...text.matchAll(/`+/g)].map(([run]) => run.length)) + 1)
  return `${fence}text\n${text}\n${fence}`
}

const failures = outcomes.filter((outcome) => outcome !== null)
const reported = failures.slice(0, MAX_REPORTED_FAILURES).map(reportLine)
if (failures.length > reported.length) reported.push(`and ${failures.length - reported.length} more failures`)
// Fenced once, here, for the step summary and the tracking issue alike. Inside the fence, links and
// mentions in upstream text stay inert.
const report = fenced(reported.join('\n'))

// In the scheduled workflow, publish the report where the run page and the tracking issue can show
// it, so the cause outlives the run's log retention.
const summaryPath = process.env['GITHUB_STEP_SUMMARY']
if (summaryPath) {
  appendFileSync(
    summaryPath,
    failures.length > 0
      ? `## Upstream monitor\n\n${failures.length} of ${checks.length} upstream checks failed.\n\n${report}\n`
      : `## Upstream monitor\n\nAll ${checks.length} upstream checks passed.\n`
  )
}
const outputPath = process.env['GITHUB_OUTPUT']
if (outputPath && failures.length > 0) {
  // A random delimiter, so no failure text can end the value early and inject another output.
  const delimiter = `report_${randomUUID()}`
  appendFileSync(outputPath, `report<<${delimiter}\n${report}\n${delimiter}\n`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks.length} upstream checks failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${checks.length} upstream checks passed.`)
}
