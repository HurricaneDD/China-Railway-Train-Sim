export type BasemapId = 'street' | 'satellite' | 'plain' | 'none';

export interface BasemapProvider {
  id: Exclude<BasemapId, 'none'>;
  name: string;
  /** Short attribution drawn on the canvas. */
  attribution: string;
  minZoom: number;
  maxZoom: number;
  /** CSS pixels per tile at its native zoom. */
  tileSize: number;
  tileUrl(z: number, x: number, y: number): string;
}

/**
 * Both providers are standard WGS84 Web Mercator tiles and are keyless.
 * They are deliberately not AMap/Tencent/Google China tiles, which would
 * introduce GCJ-02 offsets relative to the WGS84 railway geometry.
 *
 * CARTO's public dark tiles currently render an "API KEY REQUIRED" watermark,
 * so they are not used. The street layer is drawn under a dark overlay.
 */
export const BASEMAPS: Record<Exclude<BasemapId, 'none'>, BasemapProvider> = {
  street: {
    id: 'street',
    name: '街道',
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
    attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
    minZoom: 2,
    maxZoom: 19,
    tileSize: 256,
    tileUrl(z, x, y) {
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    },
  },
};
