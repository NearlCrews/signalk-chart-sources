import type { ChartSource } from './types.js'

// Every v1 upstream, transcribed from the Binnacle chartplotter source modules so the webapp render
// config and the companion proxy allowlist never drift. The webapp augments these with its UI-only
// metadata (parent, region, category, opacity) by id. The NASA GIBS ocean fields are date-dynamic
// (a {date} path segment) and are deferred to v2 with daily re-push; they stay direct in v1.

const NOAA_ENC_WMS = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer'
const EMODNET_WMS = 'https://ows.emodnet-bathymetry.eu/wms'
const EMODNET_HA_WMS = 'https://ows.emodnet-humanactivities.eu/wms'
const BLUETOPO_WMS = 'https://nowcoast.noaa.gov/geoserver/bluetopo/wms'
const MARINE_REGIONS_WMS = 'https://geo.vliz.be/geoserver/MarineRegions/wms'
const NOAA_MPA_SERVER = 'https://gis.charttools.noaa.gov/arcgis/rest/services/survey_priorities2_national/MPA_Inventory_Separates/MapServer'

const EMODNET_BOUNDS: [number, number, number, number] = [-30.0, 25.0, 43.0, 84.0]
const BLUETOPO_BOUNDS: [number, number, number, number] = [-138.0, -53.876, 17.046, 59.55]
const ENC_BOUNDS: [number, number, number, number] = [-180, 17, -64, 72]

/** Build a WMS GetMap ChartSource (256 px, EPSG:3857, image/png, transparent), matching the webapp wmsTiles. */
function wms (
  id: string, title: string, base: string, layers: string, styles: string,
  extra: { minzoom?: number, maxzoom?: number, bounds?: [number, number, number, number], attribution: string, group?: { id: string, title: string } }
): ChartSource {
  return {
    id, title, tileSize: 256,
    minzoom: extra.minzoom ?? 0, maxzoom: extra.maxzoom ?? 18,
    ...(extra.bounds ? { bounds: extra.bounds } : {}),
    attribution: extra.attribution, ...(extra.group ? { group: extra.group } : {}),
    upstream: { mode: 'wms', base, layers, styles, version: '1.3.0', format: 'image/png', transparent: true }
  }
}

export const CHART_SOURCES: ChartSource[] = [
  wms('depth-gebco', 'GEBCO bathymetry', 'https://wms.gebco.net/mapserv', 'GEBCO_LATEST', '', {
    maxzoom: 12, attribution: 'GEBCO_2024 Grid, GEBCO Compilation Group (2024)'
  }),
  wms('depth-emodnet', 'EMODnet bathymetry', EMODNET_WMS, 'emodnet:mean_multicolour', '', {
    maxzoom: 12, bounds: EMODNET_BOUNDS, attribution: 'EMODnet Bathymetry Consortium (2022): EMODnet Digital Bathymetry (DTM)', group: { id: 'emodnet', title: 'EMODnet (Europe)' }
  }),
  wms('depth-emodnet-quality', 'Quality index', EMODNET_WMS, 'emodnet:quality_index', 'quality_index_combined', {
    maxzoom: 12, bounds: EMODNET_BOUNDS, attribution: 'EMODnet Bathymetry Consortium (2022): EMODnet Digital Bathymetry (DTM)', group: { id: 'emodnet', title: 'EMODnet (Europe)' }
  }),
  {
    id: 'depth-bluetopo', title: 'BlueTopo bathymetry', tileSize: 512,
    minzoom: 0, maxzoom: 16, bounds: BLUETOPO_BOUNDS,
    attribution: 'NOAA Office of Coast Survey, BlueTopo / National Bathymetric Source',
    group: { id: 'bluetopo', title: 'BlueTopo (US)' },
    upstream: { mode: 'wmts', urlTemplate: 'https://nowcoast.noaa.gov/geoserver/gwc/service/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=bluetopo:bathymetry&STYLE=&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png8' }
  },
  wms('depth-bluetopo-uncertainty', 'Uncertainty', BLUETOPO_WMS, 'bathymetry', 'nbs_uncertainty', {
    maxzoom: 16, bounds: BLUETOPO_BOUNDS, attribution: 'NOAA Office of Coast Survey, BlueTopo / National Bathymetric Source', group: { id: 'bluetopo', title: 'BlueTopo (US)' }
  }),
  wms('depth-noaa-enc', 'NOAA ENC', NOAA_ENC_WMS, '0,1,2,3,4,5,6,7,10', '', {
    bounds: ENC_BOUNDS, attribution: 'NOAA Office of Coast Survey, Electronic Navigational Charts (ENC)', group: { id: 'noaa-enc', title: 'NOAA ENC (US)' }
  }),
  wms('depth-noaa-enc-quality', 'Data quality (ZOC)', NOAA_ENC_WMS, '8,9', '', {
    bounds: ENC_BOUNDS, attribution: 'NOAA Office of Coast Survey, Electronic Navigational Charts (ENC)', group: { id: 'noaa-enc', title: 'NOAA ENC (US)' }
  }),
  {
    id: 'seamark', title: 'OpenSeaMap seamarks', tileSize: 256,
    minzoom: 0, maxzoom: 18, attribution: '© OpenSeaMap contributors, ODbL',
    upstream: { mode: 'xyz', urlTemplate: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png' }
  },
  wms('bound-eez', 'Maritime boundaries', MARINE_REGIONS_WMS, 'eez_boundaries', '', {
    attribution: 'Flanders Marine Institute (VLIZ), marineregions.org, CC-BY'
  }),
  wms('bound-12nm', 'Territorial sea (12 nm)', MARINE_REGIONS_WMS, 'eez_12nm', '', {
    attribution: 'Flanders Marine Institute (VLIZ), marineregions.org, CC-BY'
  }),
  wms('mpa-emodnet', 'Marine protected areas', EMODNET_HA_WMS, 'marineprotectedareas', '', {
    bounds: EMODNET_BOUNDS, attribution: 'EMODnet Human Activities', group: { id: 'emodnet-mpa', title: 'Protected areas (EU)' }
  }),
  wms('mpa-natura2000', 'Natura 2000', EMODNET_HA_WMS, 'natura2000areas', '', {
    bounds: EMODNET_BOUNDS, attribution: 'EMODnet Human Activities', group: { id: 'emodnet-mpa', title: 'Protected areas (EU)' }
  }),
  {
    id: 'mpa-noaa', title: 'NOAA MPA inventory', tileSize: 256,
    minzoom: 0, maxzoom: 18, bounds: [-180, 15, -60, 75],
    attribution: 'NOAA National Marine Protected Areas Center',
    upstream: { mode: 'arcgis', base: NOAA_MPA_SERVER }
  },
  {
    id: 'basemap', title: 'OpenFreeMap Liberty', tileSize: 256,
    minzoom: 0, maxzoom: 20, vectorMaxzoom: 14,
    attribution: '© OpenMapTiles, © OpenStreetMap contributors',
    upstream: { mode: 'style', styleUrl: 'https://tiles.openfreemap.org/styles/liberty', allowedHosts: ['tiles.openfreemap.org'] }
  }
]
