import assert from 'node:assert/strict'
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
import { checkedPublicHttpsUrl } from './upstream-url.js'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_FETCH_ATTEMPTS = 2
/** Pause between fetch attempts, so a transient upstream error gets a moment to clear. */
const RETRY_DELAY_MS = 500
/** How far a published WMTS matrix corner may sit from the projection origin before it is drift. */
const ORIGIN_TOLERANCE_METERS = 1
const USER_AGENT = 'signalk-chart-sources-upstream-monitor/1.0'
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
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

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, label: string): RecordValue {
  assert.ok(isRecord(value), `${label} must be an object`)
  return value
}

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

function parseXml(input: Uint8Array | string, label: string): RecordValue {
  const parsed: unknown = XML.parse(typeof input === 'string' ? input : new TextDecoder().decode(input))
  return record(parsed, label)
}

async function fetchBytesOnce(url: string): Promise<{ response: Response; bytes: Uint8Array }> {
  checkedPublicHttpsUrl(url)
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`)
  checkedPublicHttpsUrl(response.url)
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
  return { response, bytes }
}

async function fetchBytes(url: string): Promise<{ response: Response; bytes: Uint8Array }> {
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

async function discoverStyleHosts(styleUrl: string): Promise<Set<string>> {
  const hosts = new Set<string>()
  const visitedStyles = new Set<string>()
  const visitedTileJson = new Set<string>()

  const inspectTileJson = async (candidate: string, base: string): Promise<void> => {
    const url = checkedPublicHttpsUrl(candidate, base)
    hosts.add(url.hostname.toLowerCase())
    if (visitedTileJson.has(url.href)) return
    visitedTileJson.add(url.href)
    const { json: tileJson, finalUrl } = await fetchJson(url.href, 'TileJSON')
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
  return hosts
}

async function checkSource(source: ChartSource): Promise<void> {
  if (source.upstream.mode === 'style') {
    const discovered = [...(await discoverStyleHosts(source.upstream.styleUrl))].sort()
    const allowed = [...new Set(source.upstream.allowedHosts.map((host) => host.toLowerCase()))].sort()
    assert.deepEqual(allowed, discovered, `${source.id} allowedHosts drifted from its style graph`)
    console.log(`${source.id}: ${discovered.length} authorized style host(s)`)
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
 * Fetch and parse a JSON document, re-checking the URL after redirects. Style documents, TileJSON,
 * and the attribution check all need the same four steps, and the copy that skipped the redirect
 * re-check is exactly the kind of drift one helper prevents.
 */
async function fetchJson(url: string, label: string): Promise<{ json: RecordValue; finalUrl: URL }> {
  const { response, bytes } = await fetchBytes(url)
  const finalUrl = checkedPublicHttpsUrl(response.url)
  assert.match(response.headers.get('content-type') ?? '', /json/i, `${finalUrl} content type drifted`)
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
  return { json: record(parsed, `${finalUrl} ${label}`), finalUrl }
}

/**
 * Check an XYZ source against the TileJSON its service publishes. A tile template carries no
 * metadata of its own, so without this the transcribed attribution is checked by nothing: Seascape
 * shortened its credit line and the monitor stayed green through it. The URL lives on the source
 * rather than in a table here, because the catalog is the only place upstream data belongs.
 */
async function checkTileJsonAttribution(source: ChartSource, tileJsonUrl: string): Promise<void> {
  const { json: tileJson } = await fetchJson(tileJsonUrl, 'TileJSON')
  const published = requiredString(tileJson['attribution'], `${source.id} upstream attribution`)
  // Exact, not a substring or a trim. The catalog's rule is that attribution is transcribed, and a
  // service that rewords its credit line has changed what the webapp is obliged to display.
  assert.equal(
    source.attribution,
    published,
    `${source.id} attribution drifted from ${tileJsonUrl}. Transcribe the upstream value into ` +
      `registry.ts and Binnacle's copy together.`
  )
  const maxzoom = tileJson['maxzoom']
  if (maxzoom !== undefined) {
    assert.equal(Number(maxzoom), source.maxzoom, `${source.id} maxzoom drifted from ${tileJsonUrl}`)
  }
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

/** The advertised geographic envelope of one WMS layer, or null when it declares none. */
function layerEnvelope(layers: Map<string, RecordValue>, name: string): LngLatBbox | null {
  const box = layers.get(name)?.['EX_GeographicBoundingBox']
  if (!isRecord(box)) return null
  const edges = ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map((edge) =>
    Number(box[edge])
  )
  return edges.every(Number.isFinite) ? (edges as unknown as LngLatBbox) : null
}

function wmsRoot(document: RecordValue, label: string): RecordValue {
  return record(document['WMS_Capabilities'] ?? document['WMT_MS_Capabilities'], label)
}

function wmsCapabilitiesUrl(base: string): string {
  return `${base}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`
}

async function checkWmsCapabilities(sources: readonly ChartSource[]): Promise<void> {
  const wmsSources = sources.filter((source) => source.upstream.mode === 'wms')
  const byBase = new Map<string, typeof wmsSources>()
  for (const source of wmsSources) {
    assert.equal(source.upstream.mode, 'wms')
    byBase.set(source.upstream.base, [...(byBase.get(source.upstream.base) ?? []), source])
  }

  await Promise.all(
    [...byBase].map(async ([base, grouped]) => {
      const { bytes } = await fetchBytes(wmsCapabilitiesUrl(base))
      const xml = new TextDecoder().decode(bytes)
      const root = wmsRoot(parseXml(xml, `${base} capabilities`), `${base} WMS root`)
      assert.equal(root['@_version'], '1.3.0', `${base} WMS version drifted`)
      const capability = record(root['Capability'], `${base} Capability`)
      const request = record(capability['Request'], `${base} Request`)
      const getMap = record(request['GetMap'], `${base} GetMap`)
      const formats = strings(getMap['Format'])
      const rootLayer = record(capability['Layer'], `${base} root Layer`)
      const layers = collectWmsLayers(rootLayer)
      const supportedCrs = new Set(strings(rootLayer['CRS']))
      assert.ok(supportedCrs.has('EPSG:3857'), `${base} no longer advertises EPSG:3857`)

      for (const source of grouped) {
        assert.equal(source.upstream.mode, 'wms')
        assert.ok(
          formats.includes(source.upstream.format),
          `${source.id} format ${source.upstream.format} is unavailable`
        )
        const requestedLayers = source.upstream.layers.split(',')
        const configuredLayers = requestedLayers.map((name) => {
          const configured = layers.get(name)
          assert.ok(configured, `${source.id} layer ${name} is unavailable`)
          return configured
        })
        // STYLES pairs with LAYERS by position, so a style must be offered by the layer it is
        // requested for. Searching every layer's styles would pass a request the server rejects.
        if (source.upstream.styles !== '') {
          // The list lengths already agree: validateChartSource enforces the pairing when the
          // catalog is built, so this only has to check availability against the live capabilities.
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
      }

      const gebco = grouped.find((source) => source.id === 'depth-gebco')
      if (gebco) {
        const servedGrid = /currently provides access to the (GEBCO_\d+) Grid/i.exec(xml)?.[1]
        assert.ok(servedGrid, 'GEBCO capabilities no longer declare the served grid version')
        assert.ok(gebco.attribution.includes(servedGrid), `GEBCO attribution does not match ${servedGrid}`)
      }

      // Every WMS source that declares bounds is checked against the envelope its own layer
      // advertises. Containment rather than equality, because some bounds are deliberately narrower:
      // the EMODnet ones come from sampling where the grid actually has data, and the advertised box
      // is the tiling extent. A catalog box reaching outside the advertised one is always wrong,
      // either a bad transcription or an upstream that shrank.
      for (const source of grouped) {
        if (!source.bounds) continue
        assert.equal(source.upstream.mode, 'wms')
        const advertised = layerEnvelope(layers, source.upstream.layers.split(',')[0] ?? '')
        if (!advertised) continue
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

      const noaa = grouped.find((source) => source.id === 'depth-noaa-enc')
      if (noaa) {
        // Exact for this one, on top of the containment check above. Its coverage regions were
        // derived from the ENC product catalog against this envelope, so the envelope moving at all
        // is the signal to re-derive them, not just a signal that the bounds are still legal.
        const box = record(rootLayer['EX_GeographicBoundingBox'], 'NOAA geographic envelope')
        const coordinate = (name: string): number => {
          const value = Number(requiredString(box[name], `NOAA ${name}`))
          assert.ok(Number.isFinite(value), `NOAA ${name} must be finite`)
          return value
        }
        assert.deepEqual(
          noaa.bounds,
          [
            coordinate('westBoundLongitude'),
            coordinate('southBoundLatitude'),
            coordinate('eastBoundLongitude'),
            coordinate('northBoundLatitude')
          ],
          'NOAA ENC service envelope drifted'
        )
      }
      console.log(`${base}: WMS capabilities verified for ${grouped.length} source(s)`)
    })
  )
}

/** The template with its tokens zeroed: a valid URL whose query still names the configured layer. */
function zeroedTemplateUrl(template: string): URL {
  return checkedPublicHttpsUrl(template.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0'))
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
  const root = record(document['Capabilities'], `${source.id} WMTS root`)
  assert.equal(root['@_version'], '1.0.0', `${source.id} WMTS version drifted`)
  const contents = record(root['Contents'], `${source.id} WMTS contents`)
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

const checks: ReadonlyArray<readonly [string, Promise<void>]> = [
  ...CHART_SOURCES.map((source) => [source.id, checkSource(source)] as const),
  ['WMS capabilities', checkWmsCapabilities(CHART_SOURCES)] as const,
  ...CHART_SOURCES.filter((source) => source.upstream.mode === 'wmts').map(
    (source) => [`${source.id} WMTS capabilities`, checkWmtsCapabilities(source)] as const
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
      return `${label}: ${error instanceof Error ? error.message : String(error)}`
    }
  })
)

assert.ok(chartSourceById('depth-gebco'), 'catalog lookup failed after upstream checks')

const failures = outcomes.filter((outcome) => outcome !== null)
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checks.length} upstream checks failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`\nAll ${checks.length} upstream checks passed.`)
}
