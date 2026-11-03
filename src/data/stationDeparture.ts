import { APP_CONFIG } from '../config';
import type { RailNetwork } from './railway';
import type { LonLat, RailSegment, Station, StationDeparture, StationDepartureContextTrack, StationDepartureTrack } from '../types';
import { bearing, nearestOnSegment, pointAt } from '../utils/geo';

/**
 * Station departure snapshot.
 *
 * The railway data has no yard, platform or track-number table. This module only
 * groups the OSM rail segments that pass near the station, keeps their original
 * coordinates, and derives a heuristic travel direction. It never invents tracks,
 * switches or connections.
 */

const UP_REFERENCE = APP_CONFIG.stationDeparture.upReference;

/** Angular difference in degrees, always in [0, 180]. */
export function angleDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Heuristic only: Chinese main-line up (上行) direction is normally defined toward
 * Beijing. Where that convention does not apply, this still gives a stable,
 * explainable initial heading for the simulator.
 */
export function estimatedUpSign(point: LonLat, coordinateHeading: number): 1 | -1 {
  return angleDifference(coordinateHeading, bearing(point, UP_REFERENCE)) <= 90 ? 1 : -1;
}

/** Slice a segment symmetrically around an offset without moving its coordinates. */
export function trackWindow(segment: RailSegment, offset: number, halfWindow: number): LonLat[] {
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

function toTrack(network: RailNetwork, segment: RailSegment, center: LonLat): StationDepartureTrack | undefined {
  const snapped = nearestOnSegment(segment, center);
  if (!snapped) return undefined;
  const at = pointAt(segment, snapped.offset);
  const upSign = estimatedUpSign(at, at.heading);
  const upBearing = upSign > 0 ? at.heading : (at.heading + 180) % 360;
  const upBoundary = network.nextBoundary(segment.id, snapped.offset, upSign);
  const downBoundary = network.nextBoundary(segment.id, snapped.offset, -upSign);
  const upBoundaryAhead = upBoundary ? Math.abs(upBoundary.offset - snapped.offset) : Infinity;
  const downBoundaryAhead = downBoundary ? Math.abs(downBoundary.offset - snapped.offset) : Infinity;
  return {
    segmentId: segment.id,
    name: segment.properties.name,
    distance: snapped.distance,
    offset: snapped.offset,
    segmentLength: segment.length,
    heading: at.heading,
    upSign,
    upBearing,
    upBoundaryAhead,
    downBoundaryAhead,
    upContinues: upBoundary ? network.drivableExits(segment.id, upBoundary, upSign).length > 0 : false,
    downContinues: downBoundary ? network.drivableExits(segment.id, downBoundary, -upSign).length > 0 : false,
    bridge: segment.properties.bridge,
    tunnel: segment.properties.tunnel,
    points: trackWindow(segment, snapped.offset, APP_CONFIG.stationDeparture.trackWindowMeters),
  };
}

export function buildStationDeparture(network: RailNetwork, station: Station): StationDeparture {
  const center: LonLat = { lon: station.longitude, lat: station.latitude };
  const config = APP_CONFIG.stationDeparture;
  const nearby = network.segmentsNear(center, config.trackRadius, config.maxContextSegments);
  const contextTracks: StationDepartureContextTrack[] = nearby.map((segment) => {
    const snapped = nearestOnSegment(segment, center);
    return { segmentId: segment.id, points: trackWindow(segment, snapped?.offset ?? 0, config.trackWindowMeters) };
  });
  const allTracks = nearby
    .map((segment) => toTrack(network, segment, center))
    .filter((track): track is StationDepartureTrack => !!track)
    .sort((a, b) => a.distance - b.distance || b.segmentLength - a.segmentLength);
  const tracks = allTracks.slice(0, config.maxTracks);
  return {
    station,
    center,
    towardBeijing: bearing(center, UP_REFERENCE),
    tracks,
    contextTracks,
    radius: config.trackRadius,
    truncated: allTracks.length > tracks.length || nearby.length >= config.maxContextSegments,
  };
}

/** Direction along the original coordinate array for the chosen up/down departure. */
export function departureDirection(track: StationDepartureTrack, up: boolean): 1 | -1 {
  return (up ? track.upSign : -track.upSign) as 1 | -1;
}

/** Compass bearing of the chosen departure direction. */
export function departureBearing(track: StationDepartureTrack, up: boolean): number {
  return up ? track.upBearing : (track.upBearing + 180) % 360;
}
