import type { ChartSource } from './types.js'

// Half the web-mercator extent in meters (EPSG:3857). The webapp and the container both use this one
// constant, so the TS and Rust copies are bit-exact.
const ORIGIN = 20037508.342789244

/**
 * EPSG:3857 bounds [minX, minY, maxX, maxY] of XYZ tile z/x/y. y increases downward (north at the
 * top), matching MapLibre's {bbox-epsg-3857} substitution to sub-ULP. The cache key is z/x/y, not
 * the bbox, so any sub-ULP difference from MapLibre is irrelevant; the only hard requirement is that
 * this and the Rust container copy agree, which they do (same formula, constant, and IEEE-754).
 */
export function webMercatorTileBounds (z: number, x: number, y: number): [number, number, number, number] {
  const size = (2 * ORIGIN) / 2 ** z
  const minX = -ORIGIN + x * size
  const maxX = minX + size
  const maxY = ORIGIN - y * size
  const minY = maxY - size
  return [minX, minY, maxX, maxY]
}

// The Web Mercator latitude limit (about plus or minus 85.0511 degrees). Beyond it the projection is
// undefined, so callers clamp to it before projecting.
export const MAX_MERCATOR_LAT = 85.0511287798066

/**
 * The standard slippy-tile floor: the integer tile z/x/y that contains (lng, lat). This is the inverse
 * of webMercatorTileBounds. Unlike the forward direction it need not be bit-exact across the TS and the
 * Rust; it only selects which integer tiles to enumerate, and those tiles then flow through the same
 * forward expand path and produce the same cache key. The Rust container carries the same formula.
 */
export function tileForLngLat (lng: number, lat: number, z: number): { x: number, y: number } {
  const n = 2 ** z
  const clampedLat = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat))
  const latRad = (clampedLat * Math.PI) / 180
  const xf = Math.floor(((lng + 180) / 360) * n)
  const yf = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n)
  const max = n - 1
  return {
    x: Math.min(max, Math.max(0, xf)),
    y: Math.min(max, Math.max(0, yf))
  }
}

export type ZXY = { z: number, x: number, y: number }

// Clip the request bbox to the source bounds and the Mercator latitude limit, and reject a non-finite,
// degenerate, or antimeridian-crossing (minLng > maxLng) box. Returns null when nothing remains.
function clipBbox (source: ChartSource, bbox: [number, number, number, number]): [number, number, number, number] | null {
  let [minLng, minLat, maxLng, maxLat] = bbox
  if (![minLng, minLat, maxLng, maxLat].every(Number.isFinite)) return null
  if (minLng > maxLng) return null
  if (source.bounds) {
    const [bMinLng, bMinLat, bMaxLng, bMaxLat] = source.bounds
    minLng = Math.max(minLng, bMinLng); minLat = Math.max(minLat, bMinLat)
    maxLng = Math.min(maxLng, bMaxLng); maxLat = Math.min(maxLat, bMaxLat)
  }
  minLat = Math.max(minLat, -MAX_MERCATOR_LAT); maxLat = Math.min(maxLat, MAX_MERCATOR_LAT)
  if (minLng >= maxLng || minLat >= maxLat) return null
  return [minLng, minLat, maxLng, maxLat]
}

function zoomBounds (source: ChartSource, [zmin, zmax]: [number, number]): [number, number] {
  return [Math.max(zmin, source.minzoom), Math.min(zmax, source.maxzoom, source.vectorMaxzoom ?? source.maxzoom)]
}

// The inclusive tile rectangle [x0..x1] by [y0..y1] covering the clipped bbox at zoom z. y increases
// downward, so the north edge (maxLat) is the smaller y.
function tileRange (clip: [number, number, number, number], z: number): { x0: number, x1: number, y0: number, y1: number } {
  const [minLng, minLat, maxLng, maxLat] = clip
  const tl = tileForLngLat(minLng, maxLat, z)
  const br = tileForLngLat(maxLng, minLat, z)
  return { x0: tl.x, x1: br.x, y0: tl.y, y1: br.y }
}

/** The number of tiles that would be covered over this bbox and zoom range. Upper-bound gate for the panel estimate. */
export function tileCountInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): number {
  const clip = clipBbox(source, bbox)
  if (!clip) return 0
  const [zmin, zmax] = zoomBounds(source, zoomRange)
  let count = 0
  for (let z = zmin; z <= zmax; z++) {
    const { x0, x1, y0, y1 } = tileRange(clip, z)
    count += (x1 - x0 + 1) * (y1 - y0 + 1)
  }
  return count
}

/** Enumerate every z/x/y that would be covered over this bbox and zoom range. */
export function tilesInBbox (source: ChartSource, bbox: [number, number, number, number], zoomRange: [number, number]): ZXY[] {
  const clip = clipBbox(source, bbox)
  if (!clip) return []
  const [zmin, zmax] = zoomBounds(source, zoomRange)
  const out: ZXY[] = []
  for (let z = zmin; z <= zmax; z++) {
    const { x0, x1, y0, y1 } = tileRange(clip, z)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) out.push({ z, x, y })
    }
  }
  return out
}
