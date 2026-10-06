// Request text shared by the URL builders and the validator, which checks the request a source would
// send rather than each field on its own. Imports types only, so validate.ts can depend on it.
import type { UpstreamTemplate } from './types.js'

const ZXY_TOKEN = /\{(z|x|y)\}/g

/** Fill the {z}, {x}, and {y} tokens of a tile template. */
export function substituteZXY(template: string, z: number, x: number, y: number): string {
  return template.replace(ZXY_TOKEN, (_, key) => String(key === 'z' ? z : key === 'x' ? x : y))
}

/**
 * Drop trailing slashes from a base URL. ArcGIS needs it because the export path is appended and a
 * kept slash would double up. WMS gets the same treatment so one base cannot produce two spellings
 * of the same request, which would split a proxy's cache for no benefit.
 */
export function withoutTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === 47) end--
  return value.slice(0, end)
}

/** MapLibre's placeholder for the EPSG:3857 tile bbox, which it fills in for every tile it requests. */
export const MAPLIBRE_BBOX_TOKEN = '{bbox-epsg-3857}'

type BboxRequestUpstream = Extract<UpstreamTemplate, { mode: 'wms' | 'arcgis' }>

/**
 * The WMS GetMap or ArcGIS export request for a source, with the BBOX value the caller supplies: the
 * real tile box for an upstream request, or MapLibre's token for a tile template. One builder serves
 * both, so the direct and proxied requests cannot drift apart anywhere but the box itself.
 */
export function bboxRequestUrl(tileSize: number, upstream: BboxRequestUpstream, bbox: string): string {
  const base = withoutTrailingSlashes(upstream.base)
  if (upstream.mode === 'arcgis') {
    return (
      `${base}/export?bbox=${bbox}&bboxSR=3857&imageSR=3857` +
      `&size=${tileSize},${tileSize}&dpi=96&format=png32&transparent=true&f=image`
    )
  }
  // Raw parameter text, with no URL encoding of the comma-listed LAYERS or the STYLES, which is also
  // what upstreamTileTemplate hands the webapp, so the proxied and direct paths request the same
  // image. MapLibre fills the template's bbox token by deriving each edge independently, so the two
  // paths can still differ in a coordinate's final digit. TRANSPARENT stays lowercase although WMS
  // 1.3.0 spells the values TRUE and FALSE: every catalog server accepts it, and the Rust
  // expand_upstream writes it the same way, so changing it here alone would split every WMS cache key.
  return (
    `${base}?SERVICE=WMS&VERSION=${upstream.version}&REQUEST=GetMap&LAYERS=${upstream.layers}` +
    `&CRS=EPSG:3857&BBOX=${bbox}&WIDTH=${tileSize}&HEIGHT=${tileSize}` +
    `&FORMAT=${upstream.format}&TRANSPARENT=${upstream.transparent}&STYLES=${upstream.styles}`
  )
}
