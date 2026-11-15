import type { BasemapCoordinateSystem } from '../../src/map/basemap';
import type { Station } from '../../src/types';
import { wgs84ToGcj02 } from '../../src/utils/gcj02';
import { projectMercator, type WorldPoint } from '../../src/utils/mercator';

/** Station labels appear only when the raster map is at least this tile zoom. */
export const STATION_MIN_TILE_ZOOM = 12;
export const STATION_LABEL_MAX_CHARS = 14;

export interface StationWorldPoint {
  station: Station;
  /** Display-only Web Mercator position in the basemap's coordinate system. */
  world: WorldPoint;
}

/**
 * Convert WGS84 station coordinates to the display frame required by the
 * basemap. Raw station records are never mutated; topology, saves and the
 * inspector detail panel continue to use WGS84.
 */
export function stationWorldPoints(stations: readonly Station[], coordinateSystem: BasemapCoordinateSystem): StationWorldPoint[] {
  return stations
    .filter(station => Number.isFinite(station.longitude) && Number.isFinite(station.latitude))
    .map(station => {
      const source = { lon: station.longitude, lat: station.latitude };
      const display = coordinateSystem === 'gcj02' ? wgs84ToGcj02(source) : source;
      return { station, world: projectMercator(display.lon, display.lat) };
    });
}

export function stationLabel(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > STATION_LABEL_MAX_CHARS
    ? `${trimmed.slice(0, STATION_LABEL_MAX_CHARS - 1)}…`
    : trimmed;
}
