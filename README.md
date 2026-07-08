# signalk-chart-sources

[![npm version](https://img.shields.io/npm/v/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![npm downloads](https://img.shields.io/npm/dm/signalk-chart-sources.svg)](https://www.npmjs.com/package/signalk-chart-sources)
[![CI](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml/badge.svg)](https://github.com/NearlCrews/signalk-chart-sources/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

The shared marine chart-source catalog and Web Mercator tile math for the Binnacle chartplotter
and the Chart Locker tile cache.

> This is a dependency of [signalk-chart-locker](https://github.com/NearlCrews/signalk-chart-locker)
> and [signalk-binnacle](https://github.com/NearlCrews/signalk-binnacle). It is pulled in as a
> transitive dependency, not installed directly.

## What it is

`signalk-chart-sources` holds one definition of every upstream chart and raster overlay source,
shared by the webapp that renders them and the tile cache that proxies and caches them. Keeping the
catalog and the tile math in one package means the webapp render config and the tile-cache proxy
allowlist derive from a single source and never drift.

The package is data and pure helpers only: no MapLibre, no Signal K, and no Node or browser APIs.
It has zero runtime dependencies and ships its own TypeScript types.

## Public API

Everything is exported from the package root.

### Source catalog

- `CHART_SOURCES`: the array of every chart and raster overlay source, each with its upstream URL
  template, tile size, zoom range, optional geographic bounds, and attribution.
- `chartSourceById(id)`: the catalog entry for a stable source id, or `undefined` for an unknown id.
- `ChartSource`, `UpstreamTemplate`: the types that describe a source and its five upstream modes.
- `ChartGroup`: the group descriptor a source and its facets share.
- `Bbox`, `ZoomRange`: the `[minX, minY, maxX, maxY]` box tuple (geographic boxes are
  `[west, south, east, north]` degrees) and the inclusive `[minzoom, maxzoom]` pair used across the
  API.

### Web Mercator tile math

- `webMercatorTileBounds(z, x, y)`: the EPSG:3857 bounds of an XYZ tile.
- `tileForLngLat(lng, lat, z)`: the integer tile that contains a longitude-latitude point at a zoom
  level.
- `tilesInBbox(source, bbox, zoomRange)`: every `z/x/y` tile covering a bounding box, clipped to the
  source bounds and the Mercator latitude limit.
- `tileCountInBbox(source, bbox, zoomRange)`: the tile count for that same region without allocating
  the full list.
- `MAX_MERCATOR_LAT`: the Web Mercator latitude limit (about 85.0511 degrees).
- `ZXY`: the `{ z, x, y }` tile-coordinate type.

### Upstream URL building

- `expandUpstreamUrl(source, z, x, y)`: the upstream tile URL for a source at a tile coordinate,
  covering every mode (XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and style).
- `proxyTileTemplate(pluginBase, sourceId)`: the plugin-facing tile template the chartplotter
  renders when the Chart Locker tile cache is present.

### Byte estimate

- `estimateBytes(sourceIds, bbox, zoomRange, perSourceAvgBytes)`: the upper-bound byte total for a
  region download, summing `tileCountInBbox` times each source's average tile size.
- `DEFAULT_TILE_BYTES`: the fallback per-tile size (25,000 bytes) used for a source never cached
  yet.

### Usage

```ts
import { chartSourceById, tileCountInBbox, estimateBytes, type Bbox, type ZoomRange } from 'signalk-chart-sources'

const bbox: Bbox = [-122.5, 37.7, -122.3, 37.9]
const zoomRange: ZoomRange = [0, 12]

// How many tiles would a GEBCO download over San Francisco Bay cover?
const gebco = chartSourceById('depth-gebco')!
const tiles = tileCountInBbox(gebco, bbox, zoomRange)

// The upper-bound byte total for that region, with no cached averages yet.
const bytes = estimateBytes(['depth-gebco'], bbox, zoomRange, {})
```

## Source catalog

The catalog holds 16 sources across five upstream modes (XYZ, WMTS, WMS `GetMap`, ArcGIS Export, and
vector style):

- Bathymetry overlays: GEBCO, EMODnet (with a quality index), BlueTopo (with an uncertainty layer),
  NOAA ENC (with a data-quality layer), and Seascape (globally merged depth shading, contours,
  soundings, and drying areas).
- Seamarks: OpenSeaMap.
- Maritime boundaries: exclusive economic zones and the 12 nautical mile territorial sea from Marine
  Regions.
- Marine protected areas: EMODnet, Natura 2000, and the NOAA MPA inventory.
- A vector basemap: OpenFreeMap Liberty.

Each source is keyed by a stable id that fully determines every non-`z/x/y` request parameter, so the
upstream request is reproducible from the id plus the tile coordinate alone.

## Requirements

- Node.js 20 or newer.
- No runtime dependencies.

## Installation

This package is a dependency of the Chart Locker plugin and the Binnacle chartplotter, so it is
installed for you when you install either of those. To depend on it directly:

```bash
npm install signalk-chart-sources
```

## Development

```bash
git clone https://github.com/NearlCrews/signalk-chart-sources.git
cd signalk-chart-sources
npm install
npm run typecheck   # TypeScript type-check
npm test            # node --test unit tests
npm run build       # compile TypeScript to dist/
```

## License

MIT. See [LICENSE](LICENSE) for the full text. The software is provided "AS IS", without warranty of
any kind.
