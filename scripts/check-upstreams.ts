import assert from 'node:assert/strict'
import { CHART_SOURCES, chartSourceById, expandUpstreamUrl } from '../src/index.js'
import type { ChartSource } from '../src/types.js'

const REQUEST_TIMEOUT_MS = 30_000
const USER_AGENT = 'signalk-chart-sources-upstream-monitor/1.0'

async function fetchBytes (url: string): Promise<{ response: Response, bytes: Uint8Array }> {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  assert.ok(response.ok, `${url} returned HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.ok(bytes.byteLength > 0, `${url} returned an empty body`)
  return { response, bytes }
}

function expectedContentType (source: ChartSource): RegExp {
  if (source.upstream.mode === 'style') return /json/i
  if (source.upstream.mode === 'xyz' && source.upstream.urlTemplate.endsWith('.pbf')) return /protobuf|octet-stream/i
  if (source.upstream.mode === 'xyz' && source.upstream.urlTemplate.endsWith('.webp')) return /image\/webp/i
  return /image\//i
}

function assertPngDimensions (source: ChartSource, contentType: string, bytes: Uint8Array): void {
  if (!/image\/png/i.test(contentType)) return
  assert.ok(bytes.byteLength >= 24, `${source.id} returned a truncated PNG`)
  const signature = [...bytes.subarray(0, 8)]
  assert.deepEqual(signature, [137, 80, 78, 71, 13, 10, 26, 10], `${source.id} returned invalid PNG data`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(16), source.tileSize, `${source.id} PNG width drifted`)
  assert.equal(view.getUint32(20), source.tileSize, `${source.id} PNG height drifted`)
}

function styleHosts (style: Record<string, unknown>, base: string): Set<string> {
  const candidates: string[] = []
  if (typeof style.sprite === 'string') candidates.push(style.sprite)
  if (typeof style.glyphs === 'string') candidates.push(style.glyphs)
  if (style.sources && typeof style.sources === 'object') {
    for (const value of Object.values(style.sources)) {
      if (!value || typeof value !== 'object') continue
      const source = value as { url?: unknown, tiles?: unknown }
      if (typeof source.url === 'string') candidates.push(source.url)
      if (Array.isArray(source.tiles)) candidates.push(...source.tiles.filter((url): url is string => typeof url === 'string'))
    }
  }
  return new Set(candidates.map((url) => new URL(url, base).hostname))
}

async function checkSource (source: ChartSource): Promise<void> {
  const url = source.upstream.mode === 'style'
    ? source.upstream.styleUrl
    : expandUpstreamUrl(source, source.minzoom, 0, 0)
  const { response, bytes } = await fetchBytes(url)
  const contentType = response.headers.get('content-type') ?? ''
  assert.match(contentType, expectedContentType(source), `${source.id} content type drifted`)
  assertPngDimensions(source, contentType, bytes)

  if (source.upstream.mode === 'style') {
    const style = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
    for (const host of styleHosts(style, url)) {
      assert.ok(source.upstream.allowedHosts.includes(host), `${source.id} style references unauthorized host ${host}`)
    }
  }
  console.log(`${source.id}: HTTP ${response.status}, ${contentType}, ${bytes.byteLength} bytes`)
}

async function checkCapabilitiesMetadata (): Promise<void> {
  const gebco = chartSourceById('depth-gebco')
  assert.ok(gebco?.upstream.mode === 'wms')
  const gebcoCapabilities = `${gebco.upstream.base}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`
  const { bytes: gebcoBytes } = await fetchBytes(gebcoCapabilities)
  const gebcoXml = new TextDecoder().decode(gebcoBytes)
  const servedGrid = /currently provides access to the (GEBCO_\d+) Grid/i.exec(gebcoXml)?.[1]
  assert.ok(servedGrid, 'GEBCO capabilities no longer declare the served grid version')
  assert.ok(gebco.attribution.includes(servedGrid), `GEBCO attribution does not match ${servedGrid}`)

  const noaa = chartSourceById('depth-noaa-enc')
  assert.ok(noaa?.upstream.mode === 'wms')
  const noaaCapabilities = `${noaa.upstream.base}?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.3.0`
  const { bytes: noaaBytes } = await fetchBytes(noaaCapabilities)
  const noaaXml = new TextDecoder().decode(noaaBytes)
  const first = (tag: string): number => {
    const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(noaaXml)
    assert.ok(match?.[1], `NOAA capabilities omit ${tag}`)
    return Number(match[1])
  }
  assert.deepEqual(noaa.bounds, [
    first('westBoundLongitude'),
    first('southBoundLatitude'),
    first('eastBoundLongitude'),
    first('northBoundLatitude')
  ], 'NOAA ENC service envelope drifted')
}

await Promise.all(CHART_SOURCES.map(checkSource))
await checkCapabilitiesMetadata()
