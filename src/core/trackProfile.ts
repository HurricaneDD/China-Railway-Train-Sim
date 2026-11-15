import type { LonLat, RailSegment } from '../types';

export function railProfilePoints(segment: RailSegment, start: number, end: number): LonLat[] {
  let first = 0;
  while (first + 1 < segment.points.length && segment.cumulative[first + 1] <= start) first++;
  let last = Math.min(first + 1, segment.points.length - 1);
  while (last < segment.points.length - 1 && segment.cumulative[last] < end) last++;
  return segment.points.slice(first, last + 1);
}

/** Shared interpolation for the rail mesh, locomotive and grade. No invented bridge elevations. */
export function railHeight(segment: RailSegment, offset: number, height: (point: LonLat) => number | undefined): number | undefined {
  const target = Math.max(0, Math.min(segment.length, offset));
  let low = 0, high = segment.cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (segment.cumulative[mid] <= target) low = mid;
    else high = mid;
  }
  const a = height(segment.points[low]);
  const b = height(segment.points[high]);
  if (target === segment.cumulative[low]) return a;
  if (target === segment.cumulative[high]) return b;
  if (a === undefined || b === undefined) return undefined;
  const span = segment.cumulative[high] - segment.cumulative[low];
  return a + (b - a) * (span > 0 ? (target - segment.cumulative[low]) / span : 0);
}
