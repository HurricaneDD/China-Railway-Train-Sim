export type BasemapId = 'street' | 'satellite' | 'plain' | 'amap-street' | 'amap-satellite' | 'amap-hybrid' | 'none';
export type BasemapCoordinateSystem = 'wgs84' | 'gcj02';

/** Selectable 3D imagery sources. The 2D station/junction maps keep their own local toggle. */
export type MapTileId = 'amap-satellite' | 'amap-hybrid' | 'amap-street' | 'bing';

export interface MapTileOption {
  id: MapTileId;
  name: string;
  /** Short explanation shown in the settings dialog. */
  detail: string;
  coordinateSystem: BasemapCoordinateSystem;
}

export interface BasemapProvider {
  id: Exclude<BasemapId, 'none'>;
  name: string;
  /** Coordinate system of the raster tiles. Vector line data must be converted to match. */
  coordinateSystem: BasemapCoordinateSystem;
  /** Short attribution drawn on the canvas. */
  attribution: string;
  minZoom: number;
  maxZoom: number;
  /** CSS pixels per tile at its native zoom. */
  tileSize: number;
  tileUrl(z: number, x: number, y: number): string;
  /** URL template for Cesium's UrlTemplateImageryProvider; {s} picks a subdomain. */
  tileUrlTemplate?: string;
  /** Optional transparent overlay (roads/labels) drawn above this provider's base tile. */
  overlayTileUrlTemplate?: string;
  subdomains?: string[];
}

/**
 * Esri and OpenStreetMap providers use WGS84 Web Mercator. The AMap
 * providers use GCJ-02; the junction map converts its WGS84 railway geometry
 * for display only before projecting it. Never mix a GCJ-02 tile with
 * unconverted WGS84 lines: the offset is typically several hundred metres.
 *
 * CARTO's public dark tiles currently render an "API KEY REQUIRED" watermark,
 * so they are not used. All street layers are drawn under a dark overlay.
 */
export const BASEMAPS: Record<Exclude<BasemapId, 'none'>, BasemapProvider> = {
  street: {
    id: 'street',
    name: '街道',
    coordinateSystem: 'wgs84',
    attribution: 'Tiles © Esri — HERE, Garmin, © OpenStreetMap contributors',
    minZoom: 2,
    maxZoom: 19,
    tileSize: 256,
    tileUrl(z, x, y) {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
    },
  },
  plain: {
    id: 'plain',
    name: '普通',
    coordinateSystem: 'wgs84',
    attribution: '© OpenStreetMap contributors',
    minZoom: 2,
    maxZoom: 19,
    tileSize: 256,
    tileUrl(z, x, y) {
      return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
    },
  },
  satellite: {
    id: 'satellite',
    name: '卫星影像',
    coordinateSystem: 'wgs84',
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    minZoom: 2,
    maxZoom: 19,
    tileSize: 256,
    tileUrl(z, x, y) {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    },
  },
  'amap-street': {
    id: 'amap-street',
    name: '高德街道',
    coordinateSystem: 'gcj02',
    attribution: '© 高德地图',
    minZoom: 3,
    maxZoom: 19,
    tileSize: 256,
    tileUrl(z, x, y) {
      const server = (x + y) % 4 + 1;
      return `https://webrd0${server}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${x}&y=${y}&z=${z}`;
    },
    tileUrlTemplate: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
  },
  'amap-satellite': {
    id: 'amap-satellite',
    name: '高德卫星',
    coordinateSystem: 'gcj02',
    attribution: '© 高德地图',
    minZoom: 3,
    maxZoom: 18,
    tileSize: 256,
    tileUrl(z, x, y) {
      const server = (x + y) % 4 + 1;
      return `https://webst0${server}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
    },
    tileUrlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
  },
  'amap-hybrid': {
    id: 'amap-hybrid',
    name: '高德卫星（带路网）',
    coordinateSystem: 'gcj02',
    attribution: '© 高德地图',
    minZoom: 3,
    maxZoom: 18,
    tileSize: 256,
    // style=6 is satellite imagery; style=8 is the transparent road/label overlay.
    tileUrl(z, x, y) {
      const server = (x + y) % 4 + 1;
      return `https://webst0${server}.is.autonavi.com/appmaptile?style=6&x=${x}&y=${y}&z=${z}`;
    },
    tileUrlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
    overlayTileUrlTemplate: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
    subdomains: ['1', '2', '3', '4'],
  },
};

/** Order matters: the first option is the default. */
export const MAP_TILE_OPTIONS: readonly MapTileOption[] = [
  { id: 'amap-satellite', name: '高德卫星', detail: '默认 · 卫星影像', coordinateSystem: 'gcj02' },
  { id: 'amap-hybrid', name: '高德卫星（带路网）', detail: '卫星影像叠加道路与地名', coordinateSystem: 'gcj02' },
  { id: 'amap-street', name: '高德街道', detail: '矢量街道地图', coordinateSystem: 'gcj02' },
  { id: 'bing', name: 'Bing 卫星', detail: 'Cesium ion 影像，加载较慢', coordinateSystem: 'wgs84' },
];

export const DEFAULT_MAP_TILES: MapTileId = 'amap-satellite';

export function isMapTileId(value: unknown): value is MapTileId {
  return typeof value === 'string' && MAP_TILE_OPTIONS.some((option) => option.id === value);
}
