// One definition of every upstream chart and raster overlay source, shared by the Binnacle
// chartplotter webapp and the Chart Locker tile cache. Data and pure helpers only.

/** A geographic box in degrees as [west, south, east, north]. west > east crosses the antimeridian. */
export type LngLatBbox = readonly [west: number, south: number, east: number, north: number]

/** An EPSG:3857 box in meters as [minX, minY, maxX, maxY]. */
export type MercatorBbox = readonly [minX: number, minY: number, maxX: number, maxY: number]

/**
 * Backward-compatible geographic bbox name. New code should prefer LngLatBbox so degree and meter
 * boxes remain visibly distinct at API boundaries.
 */
export type Bbox = LngLatBbox

/** An inclusive [minzoom, maxzoom] pair. */
export type ZoomRange = readonly [minzoom: number, maxzoom: number]

/** A group descriptor shared by a source and its facets, so the webapp can aggregate them. */
export interface ChartGroup {
  readonly id: string
  readonly title: string
}

/** Everything required to build or authorize an upstream request. */
export type UpstreamTemplate =
  | { readonly mode: 'xyz'; readonly urlTemplate: string }
  | { readonly mode: 'wmts'; readonly urlTemplate: string }
  | {
      readonly mode: 'wms'
      readonly base: string
      readonly layers: string
      readonly styles: string
      readonly version: '1.3.0'
      readonly format: string
      readonly transparent: boolean
    }
  | { readonly mode: 'arcgis'; readonly base: string }
  | {
      readonly mode: 'style'
      readonly styleUrl: string
      readonly allowedHosts: readonly string[]
    }

/** A chart or raster overlay source shared by the renderer and tile cache. */
export interface ChartSource {
  /** Stable path-safe id that fully determines every non-z/x/y request parameter. */
  readonly id: string
  readonly title: string
  readonly upstream: UpstreamTemplate
  readonly tileSize: 256 | 512
  readonly minzoom: number
  readonly maxzoom: number
  /** Native vector-tile maximum zoom, distinct from the MapLibre overzoom render ceiling. */
  readonly vectorMaxzoom?: number
  /** Geographic display envelope. Omitted means worldwide. May cross the antimeridian. */
  readonly bounds?: LngLatBbox
  /**
   * Optional disjoint warming and estimate coverage. This is preferred over bounds for services
   * whose useful coverage cannot be represented by one rectangle. Entries may cross the
   * antimeridian and are deduplicated by tile helpers when they overlap.
   */
  readonly coverage?: readonly LngLatBbox[]
  /** Conservative first-download estimate used until a measured average exists. */
  readonly fallbackTileBytes?: number
  readonly attribution: string
  readonly group?: ChartGroup
}

export interface TileEnumerationOptions {
  /** Maximum tiles the call may enumerate before it fails closed. */
  readonly maxTiles?: number
}
