import type { ChartSource } from './types.js'
import { webMercatorTileBounds } from './mercator.js'
import { assertTileCoordinate, validateChartSource } from './validate.js'

/** Reject a z/x/y outside the tile pyramid (defense in depth; the container validates first). */
function assertInRange (source: ChartSource, z: number, x: number, y: number): void {
  validateChartSource(source)
  assertTileCoordinate(z, x, y)
  if (z < source.minzoom || z > source.maxzoom) throw new RangeError(`z ${z} out of ${source.id} range`)
}

const ZXY_TOKEN = /\{(z|x|y)\}/g

function substituteZXY (template: string, z: number, x: number, y: number): string {
  return template.replace(ZXY_TOKEN, (_, key) => String(key === 'z' ? z : key === 'x' ? x : y))
}

/** The EPSG:3857 tile bbox as the comma-joined BBOX parameter shared by the wms and arcgis requests. */
function mercatorBboxParam (z: number, x: number, y: number): string {
  return webMercatorTileBounds(z, x, y).join(',')
}

/**
 * Build the upstream URL for a source at z/x/y. XYZ and WMTS substitute the tile coordinate; WMS and
 * ArcGIS compute the EPSG:3857 tile bbox. A `style` source returns its style URL unchanged (style
 * sub-resources are expanded by the container, not here).
 *
 * @throws {TypeError | RangeError} When the source definition or tile coordinate is invalid, or the
 * zoom falls outside the source range.
 */
export function expandUpstreamUrl (source: ChartSource, z: number, x: number, y: number): string {
  assertInRange(source, z, x, y)
  const u = source.upstream
  switch (u.mode) {
    case 'xyz':
    case 'wmts':
      return substituteZXY(u.urlTemplate, z, x, y)
    case 'wms': {
      // Raw template, matching the webapp wmsTiles byte for byte (no URL encoding of the comma-listed
      // LAYERS or the STYLES), so the proxied and direct paths request the identical image.
      const bbox = mercatorBboxParam(z, x, y)
      return `${u.base}?SERVICE=WMS&VERSION=${u.version}&REQUEST=GetMap&LAYERS=${u.layers}` +
        `&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${source.tileSize}&HEIGHT=${source.tileSize}` +
        `&FORMAT=${u.format}&TRANSPARENT=${u.transparent}&STYLES=${u.styles}`
    }
    case 'arcgis': {
      const bbox = mercatorBboxParam(z, x, y)
      return `${u.base}/export?bbox=${bbox}&bboxSR=3857&imageSR=3857` +
        `&size=${source.tileSize},${source.tileSize}&dpi=96&format=png32&transparent=true&f=image`
    }
    case 'style':
      return u.styleUrl
    default: {
      // Every union member is handled above, so this is unreachable at compile time (the never
      // assignment proves exhaustiveness). It fires only on a bad or stale mode from deserialized
      // config, which the "defense in depth" contract says to reject rather than return undefined.
      const exhaustive: never = u
      throw new RangeError(`unknown upstream mode: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Return the plugin-facing tile template after removing trailing slashes from the base.
 *
 * @throws {TypeError} When the normalized base is empty or the source id is not path-safe.
 */
export function proxyTileTemplate (pluginBase: string, sourceId: string): string {
  const base = pluginBase.replace(/\/+$/, '')
  if (base === '') throw new TypeError('pluginBase must not be empty')
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(sourceId)) {
    throw new TypeError(`invalid source id: ${sourceId}`)
  }
  return `${base}/tile/${sourceId}/{z}/{x}/{y}`
}
