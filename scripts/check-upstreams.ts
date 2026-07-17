import assert from 'node:assert/strict'
import { XMLParser } from 'fast-xml-parser'
import { CHART_SOURCES, chartSourceById, expandUpstreamUrl, tileForLngLat } from '../src/index.js'
import type { ChartSource, LngLatBbox } from '../src/types.js'

const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_FETCH_ATTEMPTS = 2
const USER_AGENT = 'signalk-chart-sources-upstream-monitor/1.0'
const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true
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

function parseXml(bytes: Uint8Array, label: string): RecordValue {
  const parsed: unknown = XML.parse(new TextDecoder().decode(bytes))
  return record(parsed, label)
}

function checkedHttpsUrl(value: string, base?: string): URL {
  const url = new URL(value, base)
  assert.equal(url.protocol, 'https:', `${url} must use HTTPS`)
  assert.equal(url.username, '', `${url} must not include credentials`)
  assert.equal(url.password, '', `${url} must not include credentials`)
  return url
}

async function fetchBytesOnce(url: string): Promise<{ response: Response; bytes: Uint8Array }> {
  checkedHttpsUrl(url)
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`)
  checkedHttpsUrl(response.url)
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength)) {
    assert.ok(declaredLength <= MAX_RESPONSE_BYTES, `${url} declares an oversized response`)
  }
  assert.ok(response.body, `${url} returned no response body`)
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    byteLength += value.byteLength
    assert.ok(byteLength <= MAX_RESPONSE_BYTES, `${url} exceeded the response limit`)
    chunks.push(value)
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
      if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 500))
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

function representativeTile(source: ChartSource): readonly [number, number, number] {
  const bbox = source.coverage?.[0] ?? source.bounds ?? [-180, -85, 180, 85]
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
  if (typeof style['sprite'] === 'string') resources.push(style['sprite'])
  if (typeof style['glyphs'] === 'string') resources.push(style['glyphs'])

  for (const imported of array(style['imports'])) {
    if (isRecord(imported) && typeof imported['url'] === 'string') imports.push(imported['url'])
  }
  if (isRecord(style['sources'])) {
    for (const value of Object.values(style['sources'])) {
      if (!isRecord(value)) continue
      if (typeof value['url'] === 'string') tileJson.push(value['url'])
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
    const url = checkedHttpsUrl(candidate, base)
    hosts.add(url.hostname.toLowerCase())
    if (visitedTileJson.has(url.href)) return
    visitedTileJson.add(url.href)
    const { response, bytes } = await fetchBytes(url.href)
    const finalUrl = checkedHttpsUrl(response.url)
    hosts.add(finalUrl.hostname.toLowerCase())
    assert.match(response.headers.get('content-type') ?? '', /json/i, `${finalUrl} content type drifted`)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const tileJson = record(parsed, `${finalUrl} TileJSON`)
    for (const tile of strings(tileJson['tiles'])) {
      hosts.add(checkedHttpsUrl(tile, finalUrl.href).hostname.toLowerCase())
    }
  }

  const inspectStyle = async (candidate: string, base?: string): Promise<void> => {
    const url = checkedHttpsUrl(candidate, base)
    hosts.add(url.hostname.toLowerCase())
    if (visitedStyles.has(url.href)) return
    visitedStyles.add(url.href)
    const { response, bytes } = await fetchBytes(url.href)
    const finalUrl = checkedHttpsUrl(response.url)
    hosts.add(finalUrl.hostname.toLowerCase())
    assert.match(response.headers.get('content-type') ?? '', /json/i, `${finalUrl} content type drifted`)
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const style = record(parsed, `${finalUrl} style`)
    const references = collectStyleReferences(style)
    for (const resource of references.resources) {
      hosts.add(checkedHttpsUrl(resource, finalUrl.href).hostname.toLowerCase())
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

function collectWmsLayers(layer: unknown, layers = new Map<string, RecordValue>()): Map<string, RecordValue> {
  for (const entry of array(layer)) {
    if (!isRecord(entry)) continue
    if (typeof entry['Name'] === 'string') layers.set(entry['Name'], entry)
    collectWmsLayers(entry['Layer'], layers)
  }
  return layers
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
      const root = wmsRoot(parseXml(bytes, `${base} capabilities`), `${base} WMS root`)
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
        const requestedStyles = source.upstream.styles.split(',').filter(Boolean)
        for (const style of requestedStyles) {
          const availableStyles = configuredLayers
            .flatMap((layer) => array(layer['Style']))
            .filter(isRecord)
            .map((entry) => entry['Name'])
            .filter((name): name is string => typeof name === 'string')
          assert.ok(availableStyles.includes(style), `${source.id} style ${style} is unavailable`)
        }
      }

      const gebco = grouped.find((source) => source.id === 'depth-gebco')
      if (gebco) {
        const servedGrid = /currently provides access to the (GEBCO_\d+) Grid/i.exec(xml)?.[1]
        assert.ok(servedGrid, 'GEBCO capabilities no longer declare the served grid version')
        assert.ok(gebco.attribution.includes(servedGrid), `GEBCO attribution does not match ${servedGrid}`)
      }

      const noaa = grouped.find((source) => source.id === 'depth-noaa-enc')
      if (noaa) {
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

function wmtsCapabilitiesUrl(template: string): string {
  const url = checkedHttpsUrl(template.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0'))
  url.search = ''
  url.searchParams.set('SERVICE', 'WMTS')
  url.searchParams.set('VERSION', '1.0.0')
  url.searchParams.set('REQUEST', 'GetCapabilities')
  return url.href
}

async function checkWmtsCapabilities(source: ChartSource): Promise<void> {
  assert.equal(source.upstream.mode, 'wmts')
  const configured = checkedHttpsUrl(
    source.upstream.urlTemplate.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0')
  )
  const { bytes } = await fetchBytes(wmtsCapabilitiesUrl(source.upstream.urlTemplate))
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
  }
  console.log(`${source.id}: WMTS capabilities verified through z${source.maxzoom}`)
}

await Promise.all([
  ...CHART_SOURCES.map(checkSource),
  checkWmsCapabilities(CHART_SOURCES),
  ...CHART_SOURCES.filter((source) => source.upstream.mode === 'wmts').map(checkWmtsCapabilities)
])

assert.ok(chartSourceById('depth-gebco'), 'catalog lookup failed after upstream checks')
