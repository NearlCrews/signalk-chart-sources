import { MIN_TILE_EDGE_METERS, webMercatorTileBounds } from './mercator.js'
import type { ChartSource } from './types.js'
import { assertSourceId, assertTileCoordinate, containsInvalidUrlCharacter, validateChartSource } from './validate.js'

/** Reject a z/x/y outside the tile pyramid (defense in depth; the container validates first). */
function assertInRange(source: ChartSource, z: number, x: number, y: number): void {
  validateChartSource(source)
  assertTileCoordinate(z, x, y)
  if (z < source.minzoom || z > source.maxzoom) throw new RangeError(`z ${z} out of ${source.id} range`)
}

/**
 * Copy a candidate source into plain data properties so validation and expansion read the same
 * values. A source built on accessors could otherwise hand the validator a compliant URL and this
 * builder a different, unvalidated one. Non-objects pass through for the validator to reject with
 * its own message.
 */
function materialize(source: ChartSource): ChartSource {
  if (typeof source !== 'object' || source === null) return source
  const upstream: unknown = source.upstream
  if (typeof upstream !== 'object' || upstream === null) return { ...source }
  return { ...source, upstream: { ...upstream } as ChartSource['upstream'] }
}

const ZXY_TOKEN = /\{(z|x|y)\}/g

function withoutTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

function substituteZXY(template: string, z: number, x: number, y: number): string {
  return template.replace(ZXY_TOKEN, (_, key) => String(key === 'z' ? z : key === 'x' ? x : y))
}

/**
 * A tile edge that lands on the projection origin leaves floating-point residue near zero rather
 * than exactly zero, and Number#toString renders a small enough magnitude in exponential notation,
 * which the OGC BBOX grammar does not admit. Anything below half the smallest real tile edge is that
 * residue, so it is written as the zero it represents.
 */
const RESIDUE_LIMIT_METERS = MIN_TILE_EDGE_METERS / 2

function bboxNumber(meters: number): string {
  return Math.abs(meters) < RESIDUE_LIMIT_METERS ? '0' : String(meters)
}

/** The EPSG:3857 tile bbox as the comma-joined BBOX parameter shared by the wms and arcgis requests. */
function mercatorBboxParam(z: number, x: number, y: number): string {
  const [minX, minY, maxX, maxY] = webMercatorTileBounds(z, x, y)
  return `${bboxNumber(minX)},${bboxNumber(minY)},${bboxNumber(maxX)},${bboxNumber(maxY)}`
}

/**
 * Build the upstream URL for a source at z/x/y. XYZ and WMTS substitute the tile coordinate; WMS and
 * ArcGIS compute the EPSG:3857 tile bbox. A `style` source returns its style URL unchanged (style
 * sub-resources are expanded by the container, not here).
 *
 * @throws {TypeError | RangeError} When the source definition or tile coordinate is invalid, or the
 * zoom falls outside the source range.
 */
export function expandUpstreamUrl(candidate: ChartSource, z: number, x: number, y: number): string {
  const source = materialize(candidate)
  assertInRange(source, z, x, y)
  const u = source.upstream
  switch (u.mode) {
    case 'xyz':
    case 'wmts':
      return substituteZXY(u.urlTemplate, z, x, y)
    case 'wms': {
      // Raw parameter text, matching the webapp wmsTiles template byte for byte (no URL encoding of
      // the comma-listed LAYERS or the STYLES), so the proxied and direct paths request the same
      // image. The webapp leaves BBOX as MapLibre's {bbox-epsg-3857} token and MapLibre derives each
      // edge independently, so the two paths can still differ in a coordinate's final digit.
      const bbox = mercatorBboxParam(z, x, y)
      return (
        `${u.base}?SERVICE=WMS&VERSION=${u.version}&REQUEST=GetMap&LAYERS=${u.layers}` +
        `&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${source.tileSize}&HEIGHT=${source.tileSize}` +
        `&FORMAT=${u.format}&TRANSPARENT=${u.transparent}&STYLES=${u.styles}`
      )
    }
    case 'arcgis': {
      const bbox = mercatorBboxParam(z, x, y)
      const base = withoutTrailingSlashes(u.base)
      return (
        `${base}/export?bbox=${bbox}&bboxSR=3857&imageSR=3857` +
        `&size=${source.tileSize},${source.tileSize}&dpi=96&format=png32&transparent=true&f=image`
      )
    }
    case 'style':
      return u.styleUrl
    default: {
      // validateChartSource already rejects unknown modes, so this backstop is unreachable; the
      // never assignment proves exhaustiveness at compile time.
      const exhaustive: never = u
      throw new RangeError(`unknown upstream mode: ${String((exhaustive as { mode?: unknown }).mode)}`)
    }
  }
}

/**
 * Return the plugin-facing tile template after removing trailing slashes from the base.
 *
 * @throws {TypeError} When the normalized base is empty or unsafe, or the source id is not
 * path-safe.
 */
export function proxyTileTemplate(pluginBase: string, sourceId: string): string {
  if (typeof pluginBase !== 'string') throw new TypeError('pluginBase must be a string')
  const base = withoutTrailingSlashes(pluginBase)
  if (base === '') throw new TypeError('pluginBase must not be empty')
  // A backslash joins the ban list because URL parsers treat it as a path separator, so a base
  // carrying one would resolve to a different path than the template text reads.
  if (containsInvalidUrlCharacter(base) || /[?#{}\\]/.test(base)) {
    throw new TypeError('pluginBase must not contain whitespace, controls, ?, #, braces, or backslashes')
  }
  assertSourceId(sourceId)
  return `${base}/tile/${sourceId}/{z}/{x}/{y}`
}
