import type { ChartSource, LngLatBbox, ZoomRange } from './types.js'

/** Highest zoom accepted by public tile and source validation. */
export const MAX_TILE_ZOOM = 30

const SOURCE_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

export function assertFiniteNumber (value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`)
}

export function assertZoom (z: number, label = 'zoom'): void {
  if (!Number.isInteger(z) || z < 0 || z > MAX_TILE_ZOOM) {
    throw new RangeError(`${label} must be an integer between 0 and ${MAX_TILE_ZOOM}`)
  }
}

export function assertZoomRange ([zmin, zmax]: ZoomRange): void {
  assertZoom(zmin, 'minimum zoom')
  assertZoom(zmax, 'maximum zoom')
  if (zmin > zmax) throw new RangeError('minimum zoom must not exceed maximum zoom')
}

export function assertTileCoordinate (z: number, x: number, y: number): void {
  assertZoom(z)
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`x and y must be integers at z ${z}`)
  }
  const span = 2 ** z
  if (x < 0 || x >= span || y < 0 || y >= span) {
    throw new RangeError(`x/y ${x}/${y} out of range at z ${z}`)
  }
}

export function assertLngLatBbox (bbox: LngLatBbox, label = 'bbox'): void {
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) {
    throw new RangeError(`${label} must contain four finite coordinates`)
  }
  const [west, south, east, north] = bbox
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    throw new RangeError(`${label} longitudes must fall within [-180, 180]`)
  }
  if (south < -90 || south > 90 || north < -90 || north > 90) {
    throw new RangeError(`${label} latitudes must fall within [-90, 90]`)
  }
  if (west === east || south >= north) throw new RangeError(`${label} must cover a non-zero area`)
}

function assertHttpsUrl (value: string, label: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  if (url.protocol !== 'https:') throw new TypeError(`${label} must use https`)
}

/**
 * Validate a source supplied by a consumer or declared in the built-in catalog.
 *
 * @throws {TypeError | RangeError} When identity, zooms, geography, fallback size, HTTPS URLs, URL
 * tokens, WMS layers, or style-host authorization are invalid.
 */
export function validateChartSource (source: ChartSource): void {
  if (!SOURCE_ID.test(source.id)) throw new TypeError(`invalid source id: ${source.id}`)
  if (source.title.trim() === '') throw new TypeError(`${source.id} must have a title`)
  if (source.tileSize !== 256 && source.tileSize !== 512) {
    throw new RangeError(`${source.id} tileSize must be 256 or 512`)
  }
  assertZoom(source.minzoom, `${source.id} minzoom`)
  assertZoom(source.maxzoom, `${source.id} maxzoom`)
  if (source.minzoom > source.maxzoom) throw new RangeError(`${source.id} minzoom exceeds maxzoom`)
  if (source.vectorMaxzoom !== undefined) {
    assertZoom(source.vectorMaxzoom, `${source.id} vectorMaxzoom`)
    if (source.vectorMaxzoom < source.minzoom || source.vectorMaxzoom > source.maxzoom) {
      throw new RangeError(`${source.id} vectorMaxzoom must fall within its zoom range`)
    }
  }
  if (source.bounds) assertLngLatBbox(source.bounds, `${source.id} bounds`)
  if (source.coverage) {
    if (source.coverage.length === 0) throw new RangeError(`${source.id} coverage must not be empty`)
    source.coverage.forEach((bbox, index) => assertLngLatBbox(bbox, `${source.id} coverage[${index}]`))
  }
  if (source.fallbackTileBytes !== undefined &&
      (!Number.isSafeInteger(source.fallbackTileBytes) || source.fallbackTileBytes <= 0)) {
    throw new RangeError(`${source.id} fallbackTileBytes must be a positive safe integer`)
  }

  const upstream = source.upstream
  switch (upstream.mode) {
    case 'xyz':
    case 'wmts':
      assertHttpsUrl(upstream.urlTemplate.replaceAll('{z}', '0').replaceAll('{x}', '0').replaceAll('{y}', '0'), `${source.id} template`)
      for (const token of ['{z}', '{x}', '{y}']) {
        if (!upstream.urlTemplate.includes(token)) throw new TypeError(`${source.id} template is missing ${token}`)
      }
      break
    case 'wms':
      assertHttpsUrl(upstream.base, `${source.id} WMS base`)
      if (upstream.layers === '') throw new TypeError(`${source.id} WMS layers must not be empty`)
      break
    case 'arcgis':
      assertHttpsUrl(upstream.base, `${source.id} ArcGIS base`)
      break
    case 'style': {
      assertHttpsUrl(upstream.styleUrl, `${source.id} style URL`)
      if (upstream.allowedHosts.length === 0) throw new TypeError(`${source.id} allowedHosts must not be empty`)
      const styleHost = new URL(upstream.styleUrl).hostname
      if (!upstream.allowedHosts.includes(styleHost)) {
        throw new TypeError(`${source.id} allowedHosts must include ${styleHost}`)
      }
      break
    }
  }
}
