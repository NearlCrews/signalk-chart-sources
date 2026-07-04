// One definition of every upstream chart and raster overlay source, shared by the Binnacle
// chartplotter webapp (which renders them) and the Chart Locker tile cache (which proxies and
// caches them). Data and pure helpers only: no MapLibre, no Signal K, no Node or browser APIs.

/**
 * An axis-aligned box as [minX, minY, maxX, maxY]. Geographic boxes are [west, south, east, north]
 * in degrees; webMercatorTileBounds returns the same shape in EPSG:3857 meters.
 */
export type Bbox = [number, number, number, number]

/** An inclusive [minzoom, maxzoom] pair. */
export type ZoomRange = [number, number]

/** A group descriptor shared by a source and its facets, so the webapp can aggregate them. */
export interface ChartGroup {
  id: string
  title: string
}

/**
 * What the CONTAINER needs to build the upstream request. The browser-facing path is always
 * /tile/{source}/{z}/{x}/{y} (or /style/{source} for the basemap); the container expands this per
 * `mode`. The source id (see ChartSource) fully determines every non-z/x/y parameter (LAYERS, STYLES,
 * tile size, GIBS date), so the upstream request is reproducible from the id plus z/x/y alone.
 */
export type UpstreamTemplate =
  | { mode: 'xyz', urlTemplate: string }
  | { mode: 'wmts', urlTemplate: string }
  | { mode: 'wms', base: string, layers: string, styles: string, version: '1.3.0', format: string, transparent: boolean }
  | { mode: 'arcgis', base: string }
  | { mode: 'style', styleUrl: string, allowedHosts: string[] }

/** A chart or raster overlay source. The webapp builds its render config from this; the plugin
 * builds the container allowlist from this. One list, two consumers, no drift. */
export interface ChartSource {
  /** Stable id, fully determines every non-z/x/y parameter. */
  id: string
  title: string
  upstream: UpstreamTemplate
  tileSize: 256 | 512
  minzoom: number
  maxzoom: number
  /** The native vector-tile maxzoom, distinct from maxzoom (the MapLibre overzoom render ceiling).
   * Present on a vector style source; the warm and the estimate clamp to it so they never request
   * vector tiles above the level the upstream actually serves. */
  vectorMaxzoom?: number
  /** Geographic coverage as [west, south, east, north] degrees; omitted means worldwide. */
  bounds?: Bbox
  attribution: string
  group?: ChartGroup
}
