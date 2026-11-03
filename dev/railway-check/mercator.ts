/**
 * Standard Web Mercator (EPSG:3857) helpers for the inspector.
 *
 * The railway data is WGS84 (EPSG:4326). Web Mercator is a direct projection of
 * WGS84 longitude/latitude, so no GCJ-02 or BD-09 conversion is applied.
 */
export const WEB_MERCATOR_MAX_LATITUDE = 85.05112878;
export const WEB_MERCATOR_TILE_SIZE = 256;
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6_378_137;

export interface WorldPoint {
  x: number;
  y: number;
}

export function projectMercator(lon: number, lat: number): WorldPoint {
  const clamped = Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, lat));
  const sin = Math.sin(clamped * Math.PI / 180);
  return {
    x: (lon + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

export function unprojectMercator(x: number, y: number): { lon: number; lat: number } {
  const lon = x * 360 - 180;
  const n = Math.PI * (1 - 2 * y);
  const lat = Math.atan(Math.sinh(n)) * 180 / Math.PI;
  return { lon, lat };
}

/** Horizontal metres represented by one normalized Web Mercator world unit. */
export function metresPerWorldUnit(lat: number): number {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * Math.PI / 180);
}

/** Pick a raster tile zoom for a view scale measured in CSS pixels per world unit. */
export function tileZoomForScale(scale: number, minZoom = 2, maxZoom = 20): number {
  const raw = Math.log2(Math.max(1, scale) / WEB_MERCATOR_TILE_SIZE);
  return Math.max(minZoom, Math.min(maxZoom, Math.round(raw)));
}
