import type { ChartSource } from './types.js'
import { webMercatorTileBounds } from './mercator.js'

/** Reject a z/x/y outside the tile pyramid (defense in depth; the container validates first). */
function assertInRange (source: ChartSource, z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`non-integer tile coordinate ${z}/${x}/${y}`)
  }
  if (z < source.minzoom || z > source.maxzoom) throw new RangeError(`z ${z} out of ${source.id} range`)
  const span = 2 ** z
  if (x < 0 || x >= span || y < 0 || y >= span) throw new RangeError(`x/y ${x}/${y} out of range at z ${z}`)
}

function substituteZXY (template: string, z: number, x: number, y: number): string {
  const value: Record<'z' | 'x' | 'y', string> = { z: String(z), x: String(x), y: String(y) }
  return template.replace(/\{(z|x|y)\}/g, (_, key) => value[key as 'z' | 'x' | 'y'])
}

/** The EPSG:3857 tile bbox as the comma-joined BBOX parameter shared by the wms and arcgis requests. */
function mercatorBboxParam (z: number, x: number, y: number): string {
  return webMercatorTileBounds(z, x, y).join(',')
}

/**
 * Build the upstream URL for a source at z/x/y. xyz and wmts substitute the tile coordinate; wms and
 * arcgis compute the EPSG:3857 tile bbox. A `style` source returns its style URL unchanged (style
 * sub-resources are expanded by the container, not here).
 */
export function expandUpstreamUrl (source: ChartSource, z: number, x: number, y: number): string {
  const u = source.upstream
  switch (u.mode) {
    case 'xyz':
    case 'wmts':
      assertInRange(source, z, x, y)
      return substituteZXY(u.urlTemplate, z, x, y)
    case 'wms': {
      // Raw template, matching the webapp wmsTiles byte for byte (no URL encoding of the comma-listed
      // LAYERS or the STYLES), so the proxied and direct paths request the identical image.
      assertInRange(source, z, x, y)
      const bbox = mercatorBboxParam(z, x, y)
      return `${u.base}?SERVICE=WMS&VERSION=${u.version}&REQUEST=GetMap&LAYERS=${u.layers}` +
        `&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${source.tileSize}&HEIGHT=${source.tileSize}` +
        `&FORMAT=${u.format}&TRANSPARENT=${u.transparent}&STYLES=${u.styles}`
    }
    case 'arcgis': {
      assertInRange(source, z, x, y)
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

/** The plugin-facing tile template the webapp renders when the companion is present. */
export function proxyTileTemplate (pluginBase: string, sourceId: string): string {
  return `${pluginBase}/tile/${sourceId}/{z}/{x}/{y}`
}
