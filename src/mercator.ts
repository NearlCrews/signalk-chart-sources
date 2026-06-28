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
