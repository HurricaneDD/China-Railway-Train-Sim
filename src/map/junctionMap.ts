import type { LonLat } from '../types';
import { metresPerWorldUnit, projectMercator, unprojectMercator } from '../utils/mercator';

export interface MapView {
  /** Normalized Web Mercator world coordinates at the viewport centre. */
  cx: number;
  cy: number;
  /** CSS pixels per normalized world unit. */
  scale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface ScreenPath {
  id: string;
  points: ScreenPoint[];
}

/**
 * Fit WGS84 paths into a canvas viewport without distorting scale. The map is
 * always north-up; fit only chooses centre and uniform zoom.
 */
export function fitLonLatPaths(paths: LonLat[][], width: number, height: number, padding = 36, minimumSpanMeters = 140): MapView | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const path of paths) {
    for (const point of path) {
      const projected = projectMercator(point.lon, point.lat);
      west = Math.min(west, projected.x);
      east = Math.max(east, projected.x);
      south = Math.min(south, projected.y);
      north = Math.max(north, projected.y);
    }
  }
  if (!Number.isFinite(west)) return undefined;
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const centerX = (west + east) / 2;
  const centerY = (south + north) / 2;
  const center = unprojectMercator(centerX, centerY);
  const minWorldSpan = minimumSpanMeters / metresPerWorldUnit(center.lat);
  const spanX = Math.max(minWorldSpan, east - west, 1e-12);
  const spanY = Math.max(minWorldSpan, north - south, 1e-12);
  return {
    cx: centerX,
    cy: centerY,
    scale: Math.min(availableWidth / spanX, availableHeight / spanY),
  };
}

export function screenOf(point: LonLat, view: MapView, width: number, height: number): ScreenPoint {
  const projected = projectMercator(point.lon, point.lat);
  return {
    x: width / 2 + (projected.x - view.cx) * view.scale,
    y: height / 2 + (projected.y - view.cy) * view.scale,
  };
}

/** Nearest candidate path within a generous pointer threshold. */
export function closestScreenPath(paths: ScreenPath[], x: number, y: number, threshold = 12): string | undefined {
  let bestId: string | undefined;
  let bestDistance = threshold * threshold;
  for (const path of paths) {
    for (let index = 1; index < path.points.length; index++) {
      const distanceSquared = squaredDistanceToSegment({ x, y }, path.points[index - 1], path.points[index]);
      if (distanceSquared <= bestDistance) {
        bestDistance = distanceSquared;
        bestId = path.id;
      }
    }
  }
  return bestId;
}

/** Point at a fraction of a screen path's cumulative length. */
export function pointAtPathFraction(path: ScreenPath, fraction: number): ScreenPoint {
  if (!path.points.length) return { x: 0, y: 0 };
  if (path.points.length === 1) return path.points[0];
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < path.points.length; index++) {
    total += Math.hypot(path.points[index].x - path.points[index - 1].x, path.points[index].y - path.points[index - 1].y);
    lengths.push(total);
  }
  if (total <= 0.0001) return path.points[0];
  const target = Math.max(0, Math.min(total, total * Math.max(0, Math.min(1, fraction))));
  let segment = 0;
  while (segment < lengths.length - 1 && lengths[segment] < target) segment++;
  const startLength = segment === 0 ? 0 : lengths[segment - 1];
  const span = lengths[segment] - startLength;
  const t = span > 0.0001 ? (target - startLength) / span : 0;
  const a = path.points[segment], b = path.points[segment + 1];
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function squaredDistanceToSegment(point: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-9) return (point.x - a.x) ** 2 + (point.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return (point.x - (a.x + dx * t)) ** 2 + (point.y - (a.y + dy * t)) ** 2;
}


/** Zoom around a screen anchor while keeping that map point under the cursor. */
export function zoomViewAt(view: MapView, width: number, height: number, x: number, y: number, factor: number, minScale: number, maxScale: number): MapView {
  const scale = Math.max(minScale, Math.min(maxScale, view.scale * factor));
  const worldX = view.cx + (x - width / 2) / view.scale;
  const worldY = view.cy + (y - height / 2) / view.scale;
  return {
    cx: worldX - (x - width / 2) / scale,
    cy: worldY - (y - height / 2) / scale,
    scale,
  };
}

/** Pan by a screen-pixel delta (positive moves the map content right/down). */
export function panViewBy(view: MapView, dx: number, dy: number): MapView {
  return { cx: view.cx - dx / view.scale, cy: view.cy - dy / view.scale, scale: view.scale };
}
