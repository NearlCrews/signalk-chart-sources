// One definition of every upstream chart and raster overlay source, shared by the Binnacle
// chartplotter webapp (which renders them) and the Binnacle Companion tile cache (which proxies and
// caches them). Data and pure helpers only: no MapLibre, no Signal K, no Node or browser APIs.

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
  bounds?: [number, number, number, number]
  attribution: string
  group?: { id: string, title: string }
}
