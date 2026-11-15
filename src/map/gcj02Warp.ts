import type { LonLat } from '../types';
import { projectMercator, unprojectMercator } from '../utils/mercator';
import { wgs84ToGcj02 } from '../utils/gcj02';

export const WARP_TILE_SIZE = 256;
/** Below this zoom the GCJ-02 shift is at most a couple of pixels; the source tile is used directly. */
export const GCJ02_WARP_MIN_ZOOM = 10;

export interface TileBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface TileFraction {
  x: number;
  y: number;
}

export interface Gcj02WarpPlan {
  /** Integer source tiles (same zoom) needed to cover the warped WGS84 tile. */
  sourceTiles: Array<{ x: number; y: number }>;
  /** Source canvas origin in source tile indices. */
  originX: number;
  originY: number;
  sourceWidth: number;
  sourceHeight: number;
  /** Draw the composed source canvas at this offset in a 256x256 output tile. */
  offsetX: number;
  offsetY: number;
}

export function webMercatorTileBounds(x: number, y: number, zoom: number): TileBounds {
  const tileCount = 2 ** zoom;
  const west = x / tileCount * 360 - 180;
  const east = (x + 1) / tileCount * 360 - 180;
  const latitudeAt = (row: number): number =>
    Math.atan(Math.sinh(Math.PI * (1 - 2 * row / tileCount))) * 180 / Math.PI;
  return { west, east, south: latitudeAt(y + 1), north: latitudeAt(y) };
}

/** Fractional Web Mercator tile coordinate, with 0 at the western/northern edge. */
export function lonLatToTileFraction(point: LonLat, zoom: number): TileFraction {
  const projected = projectMercator(point.lon, point.lat);
  const tileCount = 2 ** zoom;
  return { x: projected.x * tileCount, y: projected.y * tileCount };
}

/**
 * Plan the local GCJ-02 → WGS84 raster warp for one standard Web Mercator
 * tile. AMap tiles are addressed in GCJ-02; a destination WGS84 tile maps to a
 * same-zoom GCJ-02 area shifted by the local offset. The offset varies little
 * across one tile, so a subpixel translation of the source tile mosaic is
 * enough: at global zoom the full offset is smaller than a pixel, and at
 * street zoom the residual inside a tile is far below one pixel.
 */
export function planGcj02Warp(x: number, y: number, zoom: number): Gcj02WarpPlan {
  const tileCount = 2 ** zoom;
  const bounds = webMercatorTileBounds(x, y, zoom);
  const gcjCorners = [
    wgs84ToGcj02({ lon: bounds.west, lat: bounds.north }),
    wgs84ToGcj02({ lon: bounds.east, lat: bounds.north }),
    wgs84ToGcj02({ lon: bounds.west, lat: bounds.south }),
    wgs84ToGcj02({ lon: bounds.east, lat: bounds.south }),
  ];
  const fractions = gcjCorners.map((point) => lonLatToTileFraction(point, zoom));
  // A tile's own edges lie exactly on tile boundaries. Inset the queried
  // extent by a subpixel amount so a standard tile does not also pull in the
  // adjacent row/column of source images.
  const inset = 1e-4;
  const minX = Math.max(0, Math.floor(Math.min(...fractions.map((point) => point.x)) + inset));
  const maxX = Math.min(tileCount - 1, Math.floor(Math.max(...fractions.map((point) => point.x)) - inset));
  const minY = Math.max(0, Math.floor(Math.min(...fractions.map((point) => point.y)) + inset));
  const maxY = Math.min(tileCount - 1, Math.floor(Math.max(...fractions.map((point) => point.y)) - inset));

  const sourceTiles: Array<{ x: number; y: number }> = [];
  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) sourceTiles.push({ x: tx, y: ty });
  }

  // The visual centre of a Web Mercator tile is its projected centre, not the
  // arithmetic mean of the north/south latitudes.
  const projectedCentre = unprojectMercator((x + 0.5) / tileCount, (y + 0.5) / tileCount);
  const centre = wgs84ToGcj02(projectedCentre);
  const centreFraction = lonLatToTileFraction(centre, zoom);
  const offsetX = WARP_TILE_SIZE / 2 - (centreFraction.x - minX) * WARP_TILE_SIZE;
  const offsetY = WARP_TILE_SIZE / 2 - (centreFraction.y - minY) * WARP_TILE_SIZE;

  return {
    sourceTiles,
    originX: minX,
    originY: minY,
    sourceWidth: (maxX - minX + 1) * WARP_TILE_SIZE,
    sourceHeight: (maxY - minY + 1) * WARP_TILE_SIZE,
    offsetX,
    offsetY,
  };
}
