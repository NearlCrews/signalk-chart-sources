import type { ChartGroup, ChartSource, LngLatBbox } from './types.js'
import { validateChartSource } from './validate.js'

// Every shared upstream, transcribed from the Binnacle chartplotter source modules so the webapp render
// config and the companion proxy allowlist never drift. The webapp augments these with its UI-only
// metadata (parent, region, category, opacity) by id. The NASA GIBS ocean fields are date-dynamic
// (a {date} path segment) and require a future catalog design with daily re-push; they stay direct.

const NOAA_ENC_WMS =
  'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer'
const GEBCO_WMS = 'https://wms.gebco.net/mapserv'
const EMODNET_WMS = 'https://ows.emodnet-bathymetry.eu/wms'
const EMODNET_HA_WMS = 'https://ows.emodnet-humanactivities.eu/wms'
const BLUETOPO_WMS = 'https://nowcoast.noaa.gov/geoserver/bluetopo/wms'
const MARINE_REGIONS_WMS = 'https://geo.vliz.be/geoserver/MarineRegions/wms'
const NOWCOAST_WMS = 'https://nowcoast.noaa.gov/geoserver/ows'
const NOAA_MPA_SERVER =
  'https://gis.charttools.noaa.gov/arcgis/rest/services/survey_priorities2_national/MPA_Inventory_Separates/MapServer'

// How long a fetched tile of a time-dynamic source stays usable. Each is the shortest interval that
// still lets an offline boat render something recent, taken from the product's own refresh cadence.
/** NEXRAD mosaics rebuild every few minutes. */
const RADAR_MAX_AGE_SECONDS = 300
/** A new watch or warning has to reach the helm quickly, so it matches the radar interval. */
const ALERTS_MAX_AGE_SECONDS = 300
/** NHC issues full advisories every six hours and intermediate ones between. */
const CYCLONE_MAX_AGE_SECONDS = 3600
/** A daily analysis field, so six hours is still comfortably the current day's product. */
const SST_MAX_AGE_SECONDS = 21_600

// EMODnet DTM coverage, derived 2026-08-01 by sampling the live emodnet:mean_multicolour layer on a
// 2.5 degree grid across the service's advertised extent and keeping the cells that returned
// something other than its fixed 104-byte empty tile: 679 of 1568 cells carry data. The advertised
// bbox is the tiling grid, not the data, and taking it whole would warm the Sahara and most of the
// north Atlantic. Re-derive the same way if the upstream monitor reports the layer extent drifted.
const EMODNET_DTM_COVERAGE: readonly LngLatBbox[] = [
  // European seas: Mediterranean, Adriatic, Aegean, Black Sea, Baltic, North Sea, Norwegian and
  // Barents Seas, and the Arctic margin, plus the Atlantic out past the Azores.
  [-37.5, 27.5, 40.0, 85.0],
  // The eastern strip past that box: the Black Sea, the Caspian approach, and the Barents shelf.
  [40.0, 40.0, 45.0, 85.0],
  // Macaronesia and the northwest African margin: Madeira, the Canaries, and Cape Verde.
  [-37.5, 15.0, -12.5, 27.5],
  // The Caribbean around the EU overseas territories.
  [-72.5, 10.0, -57.5, 20.0],
  // Red Sea, Gulf of Suez, and the Gulf of Aden approach.
  [32.5, 22.5, 37.5, 27.5],
  [35.0, 15.0, 42.5, 25.0],
  [42.5, 15.0, 45.0, 17.5]
]
/** Display envelope for the EMODnet DTM: the union of the sampled coverage above. */
const EMODNET_DTM_BOUNDS: LngLatBbox = [-72.5, 10.0, 45.0, 85.0]
// The quality index and the contours are separate layers over the same grid, and each advertises a
// slightly smaller reach than the bathymetry does (roughly -70.5 to 43 rather than -73.1 to 45). They
// share the DTM's coverage, because they render the same data, but not its display envelope.
const EMODNET_FACET_BOUNDS: LngLatBbox = [-70.5, 11.0, 43.0, 85.0]
// The two EMODnet Human Activities overlays are a different service with a different reach, so they
// carry their own advertised envelopes rather than borrowing the bathymetry's.
const EMODNET_MPA_BOUNDS: LngLatBbox = [-42.39, 34.1, 36.17, 74.92]
const NATURA_2000_BOUNDS: LngLatBbox = [-32.37, 24.59, 34.1, 69.11]
// The BlueTopo geographic extent from the service GetCapabilities (bluetopo:bathymetry): US waters
// spanning longitude -138 to -64.198 (all western hemisphere, so all negative) and latitude 16.786 to
// 59.55 north. The tuple is [minLng, minLat, maxLng, maxLat]; do not clip the longitudes to positive
// values, which an earlier bounds error did and which drops the whole extent.
const BLUETOPO_BOUNDS: LngLatBbox = [-138.0, 16.786, -64.198, 59.55]
// The service-level geographic envelope reported by the current WMS 1.3.0 GetCapabilities. The
// actual ENC coverage is sparse inside this box, so consumers should still expect transparent tiles.
const NOAA_ENC_BOUNDS: LngLatBbox = [-180, -78.333333, 180, 81.6]
// Warming and estimate regions, derived 2026-07-27 from the NOAA ENC product catalog
// (https://www.charts.noaa.gov/ENCs/ENCProdCat.xml, issued 2026-07-25): the union of every active
// cell footprint, clustered by region and rounded outward to 0.1 degree. The catalog extremes match
// the service envelope above (Chukchi Plateau 81.6 north, Vahsel Bay -78.33 south), so re-derive
// these boxes whenever the upstream monitor reports that envelope drifted. Harbor-scale detail is
// sparse inside the larger boxes; only areas with no ENC cell at all are excluded.
const NOAA_ENC_COVERAGE: readonly LngLatBbox[] = [
  // US East Coast, Gulf coast, Great Lakes, Puerto Rico, and the US Virgin Islands.
  [-100.8, 15.6, -64.3, 52.8],
  // US West Coast, Alaska, the eastern Aleutians, the Bering Sea, and the Arctic.
  [-180, 30.5, -113.7, 81.6],
  // Aleutian Islands and Gulf of Anadyr west of the antimeridian.
  [165.6, 48, 180, 68],
  // Hawaiian Islands out to Kure Atoll, with the surrounding band-1 ocean charts.
  [-179.3, 5, -154, 30],
  [-178.8, 15.6, -153.6, 28.8],
  [-166.4, 18, -150, 30],
  // San Diego to the Aleutians and Hawaii (US1WC07) and the eastern North Pacific (US1PO02).
  [-180, 18.7, -116.3, 38.4],
  [-154, 15, -116.5, 18.8],
  // South Pacific: Cook, Samoa, Phoenix, and Line Islands (US1EEZ2), plus American Samoa and Swains.
  [-180, -7.5, -154.3, 18.8],
  [-173.8, -17.6, -165.2, -10],
  // Guam, the Northern Mariana Islands, Palau, Micronesia, the Marshall Islands, and Wake Island.
  [131, 0, 173.6, 26],
  // Panama Canal approaches.
  [-80.1, 8.7, -78, 9.9],
  // Antarctica: Arthur Harbor, and the Weddell Sea coast.
  [-64.5, -64.9, -63.9, -64.6],
  [-40, -78.4, -30, -75]
]
// Warming and estimate regions, derived 2026-08-01 from the MPA inventory's own geometry: every ring
// of all 1,623 features across the eight sub-layers, binned to a 2 degree grid and covered by the
// smallest set of boxes that leaves no occupied cell out. The service fullExtent reaches
// [-180, -15.386, 180, 74.707], but it is an envelope spanning the Pacific and warming it whole would
// enumerate most of the planet. Re-derive from the sub-layer geometry whenever that envelope drifts.
const NOAA_MPA_COVERAGE: readonly LngLatBbox[] = [
  // Hawaii, Papahanaumokuakea out to Kure, and Johnston Atoll.
  [-180, 12, -156, 30],
  [-156, 18, -154, 22],
  [176, 28, 180, 32],
  // Alaska, the Aleutians, the Bering Sea, and the Arctic coast, continuing west of the antimeridian.
  [-180, 44, -118, 76],
  [166, 46, 180, 58],
  // US West Coast from the Southern California bight to the Salish Sea.
  [-130, 30, -116, 44],
  // Gulf of Mexico, East Coast, and the Great Lakes.
  [-100, 24, -98, 28],
  [-98, 22, -64, 48],
  [-90, 48, -88, 50],
  // South Florida, Puerto Rico, and the US Virgin Islands, below the East Coast box above.
  [-76, 16, -64, 22],
  // Guam, the Northern Mariana Islands, and Wake Island.
  [142, 10, 150, 16],
  [142, 16, 172, 24],
  // Pacific Remote Islands: Palmyra, Kingman, Jarvis, Howland, and Baker.
  [-164, -4, -156, 8],
  [-178, -2, -174, 2],
  // American Samoa and Rose Atoll.
  [-172, -16, -166, -10]
]
/** Display envelope for the NOAA MPA inventory: the union of the derived coverage above. */
const NOAA_MPA_BOUNDS: LngLatBbox = [-180, -16, 180, 76]

// Attribution strings shared by more than one source, named so a correction cannot land on one copy
// and miss the other.
const GEBCO_ATTR = 'GEBCO_2024 Grid, GEBCO Compilation Group (2024)'
// Both basemaps are the same tileset and the same terms, rendered light and dark, so a corrected
// credit or a moved host must not be able to land on one and miss the other.
const OPENMAPTILES_ATTR = '© OpenMapTiles, © OpenStreetMap contributors'
const OPENFREEMAP_HOST = 'tiles.openfreemap.org'
const EMODNET_BATHY_ATTR = 'EMODnet Bathymetry Consortium (2022): EMODnet Digital Bathymetry (DTM)'
const EMODNET_HA_ATTR = 'EMODnet Human Activities'
const BLUETOPO_ATTR = 'NOAA Office of Coast Survey, BlueTopo / National Bathymetric Source'
const NOAA_ENC_ATTR = 'NOAA Office of Coast Survey, Electronic Navigational Charts (ENC)'
const VLIZ_ATTR = 'Flanders Marine Institute (VLIZ), marineregions.org, CC-BY'
// NOAA and NWS products are public domain (https://www.weather.gov/disclaimer), so these credit the
// producing office rather than carrying a license.
const NOWCOAST_RADAR_ATTR = 'NOAA/NWS nowCOAST, NEXRAD base reflectivity mosaic'
const NOWCOAST_CYCLONE_ATTR = 'NOAA/NWS/NHC nowCOAST, tropical cyclone forecast and best track'
const NOWCOAST_ALERTS_ATTR = 'NOAA/NWS nowCOAST, watches, warnings, and advisories'
const NOWCOAST_SST_ATTR = 'NOAA nowCOAST, GHRSST sea surface temperature'
// Verbatim, fetched from https://tiles.openwaters.io/seascape/vector.json's and raster.json's
// identical attribution fields on 2026-08-01, trailing space included (mirrors Binnacle's own copy
// in src/features/depth-charts/seascape-sources.ts; re-fetch and update both if Seascape's own
// attribution text changes). Upstream shortened this on or before 2026-08-01, dropping the roughly
// twenty-five underlying dataset credits it used to inline and moving them behind the license link
// this anchor points at. Transcribed rather than kept, because the catalog credits what the service
// says it serves; check-upstreams.ts compares this against the live TileJSON on every run.
// cspell:disable -- verbatim upstream attribution; never edit it to satisfy a dictionary
const SEASCAPE_ATTR = '<a href="https://openwaters.io/charts/seascape#license">© Open Water Software, LLC</a> '
// cspell:enable

// Group descriptors shared by a source and its facet, named so the group id cannot diverge between
// the two and break the webapp's group aggregation.
const GEBCO_GROUP = { id: 'gebco', title: 'GEBCO (global)' }
const EMODNET_GROUP = { id: 'emodnet', title: 'EMODnet (Europe)' }
const BLUETOPO_GROUP = { id: 'bluetopo', title: 'BlueTopo (US)' }
const NOAA_ENC_GROUP = { id: 'noaa-enc', title: 'NOAA ENC (US)' }
const EMODNET_MPA_GROUP = { id: 'emodnet-mpa', title: 'Protected areas (EU)' }
const RADAR_GROUP = { id: 'weather-radar', title: 'Weather radar (US)' }

/** Build a WMS GetMap ChartSource (256 px, EPSG:3857, image/png, transparent), matching the webapp wmsTiles. */
function wms(
  id: string,
  title: string,
  base: string,
  layers: string,
  styles: string,
  extra: {
    maxzoom?: number
    bounds?: LngLatBbox
    coverage?: readonly LngLatBbox[]
    maxAgeSeconds?: number
    attribution: string
    group?: ChartGroup
  }
): ChartSource {
  return {
    id,
    title,
    tileSize: 256,
    minzoom: 0,
    // The default suits a chart-display service. Anything coarser (a weather mosaic, a generalized
    // worldwide polygon layer) must name its own ceiling: four extra zooms is 256 times the tiles.
    maxzoom: extra.maxzoom ?? 18,
    ...(extra.bounds ? { bounds: extra.bounds } : {}),
    ...(extra.coverage ? { coverage: extra.coverage } : {}),
    ...(extra.maxAgeSeconds ? { maxAgeSeconds: extra.maxAgeSeconds } : {}),
    attribution: extra.attribution,
    fallbackTileBytes: 512_000,
    ...(extra.group ? { group: extra.group } : {}),
    upstream: { mode: 'wms', base, layers, styles, version: '1.3.0', format: 'image/png', transparent: true }
  }
}

/**
 * Build one NEXRAD base-reflectivity mosaic. The four regions are the same product served over
 * different ground, so the ceiling, the refresh cadence, the credit, and the group belong to the
 * product rather than to any one region.
 */
function radar(id: string, title: string, region: string, bounds: LngLatBbox): ChartSource {
  return wms(id, title, NOWCOAST_WMS, `weather_radar:${region}_base_reflectivity_mosaic`, '', {
    // The mosaic is about 1 km, and a cache re-fetches it every few minutes, so a deeper ceiling
    // would buy blur and pay for it on every refresh rather than once.
    maxzoom: 10,
    bounds,
    maxAgeSeconds: RADAR_MAX_AGE_SECONDS,
    attribution: NOWCOAST_RADAR_ATTR,
    group: RADAR_GROUP
  })
}

const SOURCES: ChartSource[] = [
  wms('depth-gebco', 'GEBCO bathymetry', GEBCO_WMS, 'GEBCO_LATEST', '', {
    maxzoom: 12,
    attribution: GEBCO_ATTR,
    group: GEBCO_GROUP
  }),
  // The same grid rendered flat rather than shaded, which stays legible with overlays stacked on it.
  wms('depth-gebco-color', 'Color elevation', GEBCO_WMS, 'GEBCO_LATEST_2', '', {
    maxzoom: 12,
    attribution: GEBCO_ATTR,
    group: GEBCO_GROUP
  }),
  // Measured soundings only, with the interpolated cells left out: the quality facet of a global
  // grid that is mostly interpolation.
  wms('depth-gebco-measured', 'Measured data only', GEBCO_WMS, 'GEBCO_LATEST_3', '', {
    maxzoom: 12,
    attribution: GEBCO_ATTR,
    group: GEBCO_GROUP
  }),
  wms('depth-emodnet', 'EMODnet bathymetry', EMODNET_WMS, 'emodnet:mean_multicolour', '', {
    maxzoom: 12,
    bounds: EMODNET_DTM_BOUNDS,
    coverage: EMODNET_DTM_COVERAGE,
    attribution: EMODNET_BATHY_ATTR,
    group: EMODNET_GROUP
  }),
  wms('depth-emodnet-quality', 'Quality index', EMODNET_WMS, 'emodnet:quality_index', 'quality_index_combined', {
    maxzoom: 12,
    bounds: EMODNET_FACET_BOUNDS,
    coverage: EMODNET_DTM_COVERAGE,
    attribution: EMODNET_BATHY_ATTR,
    group: EMODNET_GROUP
  }),
  // Generalized depth contours over the same DTM, the closest thing to chart-style depth lines that
  // is free and keyless outside the ENC services.
  wms('depth-emodnet-contours', 'Depth contours', EMODNET_WMS, 'emodnet:contours', '', {
    maxzoom: 12,
    bounds: EMODNET_FACET_BOUNDS,
    coverage: EMODNET_DTM_COVERAGE,
    attribution: EMODNET_BATHY_ATTR,
    group: EMODNET_GROUP
  }),
  {
    // tileSize 512 matches the upstream: the nowcoast GWC EPSG:3857 tile matrix set serves
    // 512 by 512 tiles per its WMTS GetCapabilities, and bluetopo:bathymetry publishes only
    // that matrix set.
    id: 'depth-bluetopo',
    title: 'BlueTopo bathymetry',
    tileSize: 512,
    minzoom: 0,
    maxzoom: 16,
    bounds: BLUETOPO_BOUNDS,
    fallbackTileBytes: 1_000_000,
    attribution: BLUETOPO_ATTR,
    group: BLUETOPO_GROUP,
    upstream: {
      mode: 'wmts',
      urlTemplate:
        'https://nowcoast.noaa.gov/geoserver/gwc/service/wmts?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetTile&LAYER=bluetopo:bathymetry&STYLE=&TILEMATRIXSET=EPSG:3857&TILEMATRIX=EPSG:3857:{z}&TILEROW={y}&TILECOL={x}&FORMAT=image/png8'
    }
  },
  wms('depth-bluetopo-uncertainty', 'Uncertainty', BLUETOPO_WMS, 'bathymetry', 'nbs_uncertainty', {
    maxzoom: 16,
    bounds: BLUETOPO_BOUNDS,
    attribution: BLUETOPO_ATTR,
    group: BLUETOPO_GROUP
  }),
  wms('depth-noaa-enc', 'NOAA ENC', NOAA_ENC_WMS, '0,1,2,3,4,5,6,7,10', '', {
    bounds: NOAA_ENC_BOUNDS,
    coverage: NOAA_ENC_COVERAGE,
    attribution: NOAA_ENC_ATTR,
    group: NOAA_ENC_GROUP
  }),
  wms('depth-noaa-enc-quality', 'Data quality (ZOC)', NOAA_ENC_WMS, '8,9', '', {
    bounds: NOAA_ENC_BOUNDS,
    coverage: NOAA_ENC_COVERAGE,
    attribution: NOAA_ENC_ATTR,
    group: NOAA_ENC_GROUP
  }),
  {
    // tileSize 512 matches how Seascape's own style.json declares this raster-dem source.
    id: 'seascape-dem',
    title: 'Seascape depth shading',
    tileSize: 512,
    minzoom: 0,
    maxzoom: 17,
    fallbackTileBytes: 1_000_000,
    attribution: SEASCAPE_ATTR,
    upstream: {
      mode: 'xyz',
      urlTemplate: 'https://tiles.openwaters.io/seascape/{z}/{x}/{y}.webp',
      tileJsonUrl: 'https://tiles.openwaters.io/seascape/raster.json'
    }
  },
  {
    id: 'seascape-vector',
    title: 'Seascape bathymetry vector',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 14,
    fallbackTileBytes: 750_000,
    attribution: SEASCAPE_ATTR,
    upstream: {
      mode: 'xyz',
      urlTemplate: 'https://tiles.openwaters.io/seascape/{z}/{x}/{y}.pbf',
      tileJsonUrl: 'https://tiles.openwaters.io/seascape/vector.json'
    }
  },
  {
    id: 'seamark',
    title: 'OpenSeaMap seamarks',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 18,
    fallbackTileBytes: 256_000,
    attribution: '© OpenSeaMap contributors, ODbL',
    upstream: { mode: 'xyz', urlTemplate: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png' }
  },
  // The Marine Regions layers are worldwide and served from generalized polygons, so they keep the
  // helper's chart-display ceiling: the renderer draws a crisp line at any zoom and none of them is
  // time-dynamic, so a deep zoom costs one tile rather than one tile every few minutes.
  wms('bound-eez', 'Maritime boundaries', MARINE_REGIONS_WMS, 'eez_boundaries', '', {
    attribution: VLIZ_ATTR
  }),
  wms('bound-12nm', 'Territorial sea (12 nm)', MARINE_REGIONS_WMS, 'eez_12nm', '', {
    attribution: VLIZ_ATTR
  }),
  wms('bound-24nm', 'Contiguous zone (24 nm)', MARINE_REGIONS_WMS, 'eez_24nm', '', {
    attribution: VLIZ_ATTR
  }),
  wms('bound-high-seas', 'High seas', MARINE_REGIONS_WMS, 'high_seas', '', {
    attribution: VLIZ_ATTR
  }),
  // IHO S-23 sea areas: what body of water the boat is actually in.
  wms('bound-iho', 'Sea areas (IHO)', MARINE_REGIONS_WMS, 'iho', '', {
    attribution: VLIZ_ATTR
  }),
  wms('mpa-emodnet', 'Marine protected areas', EMODNET_HA_WMS, 'marineprotectedareas', '', {
    bounds: EMODNET_MPA_BOUNDS,
    attribution: EMODNET_HA_ATTR,
    group: EMODNET_MPA_GROUP
  }),
  wms('mpa-natura2000', 'Natura 2000', EMODNET_HA_WMS, 'natura2000areas', '', {
    bounds: NATURA_2000_BOUNDS,
    attribution: EMODNET_HA_ATTR,
    group: EMODNET_MPA_GROUP
  }),
  // The only worldwide protected-area layer in the catalog; the other three are EU or US only.
  wms('mpa-unesco', 'UNESCO marine sites', MARINE_REGIONS_WMS, 'worldheritagemarineprogramme', '', {
    attribution: VLIZ_ATTR
  }),
  // Seabed infrastructure: what an anchor must not land on. Advertised envelopes, which for the two
  // cable layers really are near worldwide.
  wms('infra-power-cables', 'Power cables', EMODNET_HA_WMS, 'powercables', '', {
    bounds: [-151.77, -22.33, 166.47, 71.04],
    attribution: EMODNET_HA_ATTR
  }),
  wms('infra-telecom-cables', 'Telecom cables', EMODNET_HA_WMS, 'telecablesactual', '', {
    bounds: [-178.21, -33.82, 178.98, 61.51],
    attribution: EMODNET_HA_ATTR
  }),
  wms('infra-pipelines', 'Pipelines', EMODNET_HA_WMS, 'pipelines', '', {
    bounds: [-11.06, 36.0, 28.14, 71.57],
    attribution: EMODNET_HA_ATTR
  }),
  wms('infra-wind-farms', 'Wind farms', EMODNET_HA_WMS, 'windfarmspoly', '', {
    bounds: [-16.59, 27.73, 24.74, 65.47],
    attribution: EMODNET_HA_ATTR
  }),
  // Monthly AIS density on a 1 km grid, so it stops well short of the chart-display ceiling.
  wms('traffic-vessel-density', 'Vessel density', EMODNET_HA_WMS, 'vesseldensity_all', '', {
    maxzoom: 10,
    bounds: [-87.71, 14.96, 97.63, 85.0],
    attribution: EMODNET_HA_ATTR
  }),
  {
    id: 'mpa-noaa',
    title: 'NOAA MPA inventory',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 18,
    bounds: NOAA_MPA_BOUNDS,
    coverage: NOAA_MPA_COVERAGE,
    fallbackTileBytes: 512_000,
    attribution: 'NOAA National Marine Protected Areas Center',
    upstream: { mode: 'arcgis', base: NOAA_MPA_SERVER }
  },
  // Every source below is time-dynamic, so each carries maxAgeSeconds and the low ceiling that
  // implies. The four radar mosaics are one product in four regions and differ only in region, so
  // they are built rather than spelled out: raising the ceiling or the cadence is then one edit.
  radar('weather-radar-conus', 'US weather radar', 'conus', [-130.0, 20.003, -59.997, 55.0]),
  radar('weather-radar-alaska', 'Alaska weather radar', 'alaska', [-176.0, 49.996, -125.994, 72.0]),
  radar('weather-radar-hawaii', 'Hawaii weather radar', 'hawaii', [-164.0, 14.998, -151.001, 26.0]),
  radar('weather-radar-caribbean', 'Caribbean weather radar', 'caribbean', [-90.0, 9.996, -60.004, 25.0]),
  // No time dimension on either of the next two: the service serves the current state by design, so
  // an omitted TIME is already the answer rather than a default that could drift.
  wms('weather-tropical', 'Active tropical cyclones', NOWCOAST_WMS, 'tropical_cyclones:active_tropical_cyclones', '', {
    maxzoom: 10,
    maxAgeSeconds: CYCLONE_MAX_AGE_SECONDS,
    attribution: NOWCOAST_CYCLONE_ATTR
  }),
  wms('weather-alerts-us', 'NWS watches and warnings', NOWCOAST_WMS, 'alerts:watches_warnings_advisories', '', {
    maxzoom: 10,
    maxAgeSeconds: ALERTS_MAX_AGE_SECONDS,
    attribution: NOWCOAST_ALERTS_ATTR
  }),
  wms(
    'ocean-sst-global',
    'Sea surface temperature',
    NOWCOAST_WMS,
    'sea_surface_temperature:global_sea_surface_temperature',
    '',
    {
      maxzoom: 8,
      bounds: [-180, -85, 180, 85],
      maxAgeSeconds: SST_MAX_AGE_SECONDS,
      attribution: NOWCOAST_SST_ATTR
    }
  ),
  {
    id: 'basemap',
    title: 'OpenFreeMap Liberty',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 20,
    vectorMaxzoom: 14,
    fallbackTileBytes: 750_000,
    attribution: OPENMAPTILES_ATTR,
    upstream: {
      mode: 'style',
      styleUrl: `https://${OPENFREEMAP_HOST}/styles/liberty`,
      allowedHosts: [OPENFREEMAP_HOST]
    }
  },
  {
    // The dark-matter fork of the same OpenMapTiles schema, on the same host and the same terms, so
    // it needs no new allowed host. A chartplotter is used at night, and a genuinely dark basemap
    // beats desaturating a light one at the renderer.
    id: 'basemap-dark',
    title: 'OpenFreeMap Dark',
    tileSize: 256,
    minzoom: 0,
    maxzoom: 20,
    vectorMaxzoom: 14,
    fallbackTileBytes: 750_000,
    attribution: OPENMAPTILES_ATTR,
    upstream: {
      mode: 'style',
      styleUrl: `https://${OPENFREEMAP_HOST}/styles/dark`,
      allowedHosts: [OPENFREEMAP_HOST]
    }
  }
]

function deepFreeze<T>(value: T): T {
  const freezable = value !== null && (typeof value === 'object' || typeof value === 'function')
  if (freezable && !Object.isFrozen(value)) {
    // Freeze before recursing so a cyclic reference cannot recurse forever.
    Object.freeze(value)
    for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key))
  }
  return value
}

/**
 * The webapp aggregates a source and its facets by group id, so members of one group must agree on
 * the group title and the attribution they display. Enforced here rather than in a test alone, so a
 * mismatch cannot reach a consumer that imports the catalog without running this suite.
 */
export function assertGroupCoherence(sources: readonly ChartSource[]): void {
  const groups = new Map<string, { title: string; attribution: string; id: string }>()
  for (const source of sources) {
    if (!source.group) continue
    const seen = groups.get(source.group.id)
    if (!seen) {
      groups.set(source.group.id, {
        title: source.group.title,
        attribution: source.attribution,
        id: source.id
      })
      continue
    }
    if (seen.title !== source.group.title) {
      throw new TypeError(`group ${source.group.id} has two titles: ${seen.title} and ${source.group.title}`)
    }
    if (seen.attribution !== source.attribution) {
      throw new TypeError(`group ${source.group.id} members ${seen.id} and ${source.id} disagree on attribution`)
    }
  }
}

function defineCatalog(sources: ChartSource[]): readonly ChartSource[] {
  const ids = new Set<string>()
  for (const source of sources) {
    validateChartSource(source)
    if (ids.has(source.id)) throw new TypeError(`duplicate chart source id: ${source.id}`)
    ids.add(source.id)
  }
  assertGroupCoherence(sources)
  return deepFreeze(sources)
}

export const CHART_SOURCES: readonly ChartSource[] = defineCatalog(SOURCES)

const BY_ID = new Map(CHART_SOURCES.map((s) => [s.id, s]))

/** Look up a source by its stable id; undefined for an id not in the catalog. */
export function chartSourceById(id: string): ChartSource | undefined {
  return BY_ID.get(id)
}
