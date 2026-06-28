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
