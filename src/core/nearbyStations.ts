import type { LonLat, Station } from '../types';
import { bearing, distance } from '../utils/geo';

export interface NearbyStation {
  name: string;
  /** Geographic distance in metres, not distance along an assumed railway route. */
  distance: number;
}
export interface DirectionalStations {
  previous?: NearbyStation;
  next?: NearbyStation;
}

/** Distance decreases ahead of the instantaneous motion tangent, increases behind it. */
export function directionalNearestStations(stations: readonly Station[], point: LonLat, heading: number): DirectionalStations {
  const result: DirectionalStations = {};
  for (const station of stations) {
    if (!Number.isFinite(station.longitude) || !Number.isFinite(station.latitude)) continue;
    const target = { lon: station.longitude, lat: station.latitude };
    const metres = distance(point, target);
    // At the station or exactly abeam, neither approaching nor receding is defined.
    if (metres < 0.01) continue;
    const projection = Math.cos((bearing(point, target) - heading) * Math.PI / 180);
    if (Math.abs(projection) < 1e-8) continue;
    const side = projection > 0 ? 'next' : 'previous';
    if (!result[side] || metres < result[side]!.distance) {
      result[side] = { name: station.name, distance: metres };
    }
  }
  return result;
}
