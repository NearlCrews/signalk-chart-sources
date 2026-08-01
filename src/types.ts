// One definition of every upstream chart and raster overlay source, shared by the Binnacle
// chartplotter webapp and the Chart Locker tile cache. Data and pure helpers only.

/** A geographic box in degrees as [west, south, east, north]. west > east crosses the antimeridian. */
export type LngLatBbox = readonly [west: number, south: number, east: number, north: number]

/** An EPSG:3857 box in meters as [minX, minY, maxX, maxY]. */
export type MercatorBbox = readonly [minX: number, minY: number, maxX: number, maxY: number]

/** An inclusive [minzoom, maxzoom] pair. */
export type ZoomRange = readonly [minzoom: number, maxzoom: number]

/** A single tile address in the XYZ scheme. */
export type ZXY = Readonly<{ z: number; x: number; y: number }>

/** A group descriptor shared by a source and its facets, so the webapp can aggregate them. */
export interface ChartGroup {
  readonly id: string
  readonly title: string
}

/** Everything required to build or authorize an upstream request. */
export type UpstreamTemplate =
  | {
      readonly mode: 'xyz'
      readonly urlTemplate: string
      /**
       * The TileJSON the service publishes for this tileset, when it publishes one. A tile template
       * carries no metadata of its own, so this is what lets the scheduled monitor check the
       * transcribed attribution and zoom ceiling against what the service currently serves.
       */
      readonly tileJsonUrl?: string
    }
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
   * Optional warming and estimate coverage, preferred over bounds for a service whose useful
   * coverage cannot be represented by one rectangle. Entries may cross the antimeridian and need not
   * be disjoint: tile helpers deduplicate overlapping regions, so a tile covered by several entries
   * is still counted and enumerated once.
   */
  readonly coverage?: readonly LngLatBbox[]
  /** Conservative first-download estimate used until a measured average exists. */
  readonly fallbackTileBytes?: number
  /**
   * How long a fetched tile stays usable, in seconds. Absent means the source is static and a cache
   * may keep a tile indefinitely. Present means the source is time-dynamic: a cache must treat a
   * tile older than this as expired, and must not warm the source ahead of time, because the frames
   * it would store are stale before anyone sails into them. Weather radar and hazard overlays carry
   * this; bathymetry and chart display do not.
   */
  readonly maxAgeSeconds?: number
  readonly attribution: string
  readonly group?: ChartGroup
}

export interface TileEnumerationOptions {
  /** Maximum tiles the call may enumerate before it fails closed. */
  readonly maxTiles?: number
}
