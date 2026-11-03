import { APP_CONFIG } from '../config';
import type { RailNetwork } from './railway';
import type { LonLat, RailSegment, Station, StationDeparture, StationDepartureLine } from '../types';
import { nearestOnSegment, pointAt } from '../utils/geo';

/**
 * Station departure snapshot.
 *
 * The source data has no official station-yard or track-number table, so this
 * module only exposes nearby original lines. It deliberately performs no
 * topology query: selecting a station must not trigger a whole-network
 * ensureAttachments() build.
 */

/** Slice a segment symmetrically around an offset without moving its coordinates. */
export function lineWindow(segment: RailSegment, offset: number, halfWindow: number): LonLat[] {
  const start = Math.max(0, offset - halfWindow);
  const end = Math.min(segment.length, offset + halfWindow);
  const points: LonLat[] = [pointAt(segment, start)];
  segment.points.forEach((point, index) => {
    const at = segment.cumulative[index];
    if (at > start + 0.05 && at < end - 0.05) points.push(point);
  });
  const last = pointAt(segment, end);
  const tail = points[points.length - 1];
  if (Math.abs(tail.lon - last.lon) > 1e-9 || Math.abs(tail.lat - last.lat) > 1e-9) points.push(last);
  return points;
}

function toLine(segment: RailSegment, center: LonLat): StationDepartureLine | undefined {
  const snapped = nearestOnSegment(segment, center);
  if (!snapped) return undefined;
  const at = pointAt(segment, snapped.offset);
  return {
    segmentId: segment.id,
    name: segment.properties.name,
    distance: snapped.distance,
    offset: snapped.offset,
    segmentLength: segment.length,
    heading: at.heading,
    bridge: segment.properties.bridge,
    tunnel: segment.properties.tunnel,
    points: lineWindow(segment, snapped.offset, APP_CONFIG.stationDeparture.windowMeters),
  };
}

export function buildStationDeparture(network: RailNetwork, station: Station): StationDeparture {
  const center: LonLat = { lon: station.longitude, lat: station.latitude };
  const config = APP_CONFIG.stationDeparture;
  const nearby = network.segmentsNear(center, config.radius, config.maxLines);
  const lines = nearby
    .map((segment) => toLine(segment, center))
    .filter((line): line is StationDepartureLine => !!line)
    .sort((a, b) => a.distance - b.distance || b.segmentLength - a.segmentLength);
  return {
    station,
    center,
    radius: config.radius,
    lines,
    truncated: nearby.length >= config.maxLines,
  };
}

/** Bearing of the chosen travel direction along the original coordinate array. */
export function lineBearing(line: StationDepartureLine, direction: 1 | -1): number {
  return direction > 0 ? line.heading : (line.heading + 180) % 360;
}
