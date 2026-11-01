import type { LonLat, RailSegment, SnapResult } from '../types';

const EARTH_RADIUS = 6_371_008.8;
const rad = (value: number) => value * Math.PI / 180;

export function distance(a: LonLat, b: LonLat): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearing(a: LonLat, b: LonLat): number {
  const lat1 = rad(a.lat);
  const lat2 = rad(b.lat);
  const dLon = rad(b.lon - a.lon);
  return (Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)) * 180 / Math.PI + 360) % 360;
}

export function projectToSegment(point: LonLat, a: LonLat, b: LonLat): { position: LonLat; distance: number; fraction: number } {
  const lat = rad((point.lat + a.lat + b.lat) / 3);
  const x = (p: LonLat) => rad(p.lon - point.lon) * Math.cos(lat) * EARTH_RADIUS;
  const y = (p: LonLat) => rad(p.lat - point.lat) * EARTH_RADIUS;
  const dx = x(b) - x(a);
  const dy = y(b) - y(a);
  const lengthSq = dx * dx + dy * dy;
  const fraction = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, -(x(a) * dx + y(a) * dy) / lengthSq));
  const position = { lon: a.lon + (b.lon - a.lon) * fraction, lat: a.lat + (b.lat - a.lat) * fraction };
  return { position, distance: distance(point, position), fraction };
}

export function pointAt(segment: RailSegment, offset: number): LonLat & { heading: number } {
  const target = Math.max(0, Math.min(segment.length, offset));
  let low = 0;
  let high = segment.cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (segment.cumulative[mid] <= target) low = mid;
    else high = mid;
  }
  const a = segment.points[low];
  const b = segment.points[Math.min(low + 1, segment.points.length - 1)];
  const span = segment.cumulative[Math.min(low + 1, segment.cumulative.length - 1)] - segment.cumulative[low];
  const fraction = span > 0 ? (target - segment.cumulative[low]) / span : 0;
  return { lon: a.lon + (b.lon - a.lon) * fraction, lat: a.lat + (b.lat - a.lat) * fraction, heading: bearing(a, b) };
}

export function nearestOnSegment(segment: RailSegment, point: LonLat): SnapResult | null {
  let best: SnapResult | null = null;
  for (let i = 1; i < segment.points.length; i++) {
    const projected = projectToSegment(point, segment.points[i - 1], segment.points[i]);
    if (!best || projected.distance < best.distance) {
      best = {
        segmentId: segment.id,
        offset: segment.cumulative[i - 1] + (segment.cumulative[i] - segment.cumulative[i - 1]) * projected.fraction,
        position: projected.position,
        distance: projected.distance,
      };
    }
  }
  return best;
}

export function compassDirection(degrees: number): string {
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(degrees / 45) % 8];
}

export function offsetPoint(point: LonLat, heading: number, sideways: number): LonLat {
  const angle = rad(heading + 90);
  const dNorth = Math.cos(angle) * sideways;
  const dEast = Math.sin(angle) * sideways;
  return {
    lon: point.lon + dEast / (111_320 * Math.max(0.01, Math.cos(rad(point.lat)))),
    lat: point.lat + dNorth / 110_540,
  };
}
