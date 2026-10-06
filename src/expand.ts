import { MIN_TILE_EDGE_METERS, webMercatorTileBounds } from './mercator.js'
import { bboxRequestUrl, MAPLIBRE_BBOX_TOKEN, substituteZXY, withoutTrailingSlashes } from './request.js'
import type { ChartSource } from './types.js'
import { assertSourceId, assertTileCoordinate, checkedSource, containsInvalidUrlCharacter } from './validate.js'

/** Reject a z/x/y outside the tile pyramid (defense in depth; the container validates first). */
function assertInRange(source: ChartSource, z: number, x: number, y: number): void {
  assertTileCoordinate(z, x, y)
  if (z < source.minzoom || z > source.maxzoom) throw new RangeError(`z ${z} out of ${source.id} range`)
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
  // A validated snapshot, so the builder reads exactly the values that were validated.
  const { source } = checkedSource(candidate)
  assertInRange(source, z, x, y)
  const u = source.upstream
  // No default arm, as in upstreamTileTemplate: the string return type already makes the compiler
  // reject a mode this switch does not handle.
  switch (u.mode) {
    case 'xyz':
    case 'wmts':
      return substituteZXY(u.urlTemplate, z, x, y)
    case 'wms':
    case 'arcgis':
      return bboxRequestUrl(source.tileSize, u, mercatorBboxParam(z, x, y))
    case 'style':
      return u.styleUrl
  }
}

/**
 * Return the tile URL template a renderer such as MapLibre requests directly: the XYZ or WMTS template
 * as written, or the WMS GetMap or ArcGIS export request with MapLibre's {bbox-epsg-3857} token where
 * expandUpstreamUrl writes the tile box. Filling that token with a tile's box reproduces
 * expandUpstreamUrl for the tile, which is what keeps the direct and proxied paths on one request.
 *
 * @throws {TypeError | RangeError} When the source definition is invalid, and TypeError for a style
 * source, which has a style document rather than a tile template.
 */
export function upstreamTileTemplate(candidate: ChartSource): string {
  const { source } = checkedSource(candidate)
  const u = source.upstream
  switch (u.mode) {
    case 'xyz':
    case 'wmts':
      return u.urlTemplate
    case 'wms':
    case 'arcgis':
      return bboxRequestUrl(source.tileSize, u, MAPLIBRE_BBOX_TOKEN)
    case 'style':
      throw new TypeError(`${source.id} is a style source and has no tile template`)
  }
}

// A backslash joins the ban list because URL parsers treat it as a path separator, so a base
// carrying one would resolve to a different path than the template text reads.
const INVALID_PLUGIN_BASE_CHARACTER = /[?#{}\\]/

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
  if (containsInvalidUrlCharacter(base) || INVALID_PLUGIN_BASE_CHARACTER.test(base)) {
    throw new TypeError('pluginBase must not contain whitespace, controls, ?, #, braces, or backslashes')
  }
  assertSourceId(sourceId)
  return `${base}/tile/${sourceId}/{z}/{x}/{y}`
}
