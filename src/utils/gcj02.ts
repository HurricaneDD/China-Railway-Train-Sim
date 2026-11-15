import type { LonLat } from '../types';

/**
 * WGS84 → GCJ-02 conversion for Chinese web-map raster tiles.
 *
 * Railway data and every runtime/topology calculation stay WGS84. Only the
 * display coordinates of a GCJ-02 basemap view are converted; converted points
 * are never written back to a segment, save file, or station record.
 */
const PI = Math.PI;
const SEMI_MAJOR_AXIS = 6_378_245;
const ECCENTRICITY_SQUARED = 0.00669342162296594323;
const CHINA_BOUNDS = { west: 73.66, east: 135.05, south: 3.86, north: 53.55 };

export function isOutsideChina(point: LonLat): boolean {
  return point.lon < CHINA_BOUNDS.west || point.lon > CHINA_BOUNDS.east
    || point.lat < CHINA_BOUNDS.south || point.lat > CHINA_BOUNDS.north;
}

export function wgs84ToGcj02(point: LonLat): LonLat {
  if (isOutsideChina(point)) return { ...point };
  const latitudeDelta = transformLatitude(point.lon - 105, point.lat - 35);
  const longitudeDelta = transformLongitude(point.lon - 105, point.lat - 35);
  const radianLatitude = point.lat / 180 * PI;
  let magic = Math.sin(radianLatitude);
  magic = 1 - ECCENTRICITY_SQUARED * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  const latitudeOffset = (latitudeDelta * 180) /
    ((SEMI_MAJOR_AXIS * (1 - ECCENTRICITY_SQUARED)) / (magic * sqrtMagic) * PI);
  const longitudeOffset = (longitudeDelta * 180) /
    (SEMI_MAJOR_AXIS / sqrtMagic * Math.cos(radianLatitude) * PI);
  return { lon: point.lon + longitudeOffset, lat: point.lat + latitudeOffset };
}

/**
 * Invert the non-linear GCJ-02 offset. Three fixed-point iterations are well
 * below the raster resolution for a station map and avoid an inlined lookup table.
 */
export function gcj02ToWgs84(point: LonLat): LonLat {
  if (isOutsideChina(point)) return { ...point };
  let result = { ...point };
  for (let iteration = 0; iteration < 3; iteration++) {
    const converted = wgs84ToGcj02(result);
    result = {
      lon: result.lon + (point.lon - converted.lon),
      lat: result.lat + (point.lat - converted.lat),
    };
  }
  return result;
}

function transformLatitude(x: number, y: number): number {
  let result = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  result += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  result += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return result;
}

function transformLongitude(x: number, y: number): number {
  let result = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  result += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  result += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  result += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return result;
}
