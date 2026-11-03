export interface LonLat {
  lon: number;
  lat: number;
}

export interface Station extends LonLat {
  telecode: string;
  name: string;
  full_name: string;
  province: string;
  city: string;
  city_raw: string;
  address: string | null;
  longitude: number;
  latitude: number;
  longitude_gcj02?: number;
  latitude_gcj02?: number;
  name_alt?: string;
  province_inferred?: boolean;
  city_inferred?: boolean;
}

export interface PendingStation {
  telecode: string;
  name: string;
  pending: true;
}

export type StationResult = (Station & { pending?: false }) | PendingStation;

export interface ProvinceInfo {
  adcode: string;
  province: string;
  short_name: string;
  type: string;
  file: string;
  feature_count: number;
  point_count: number;
  size_bytes: number;
}

export interface RailProperties {
  province: string;
  osmId: string;
  code?: number;
  fclass?: string;
  name: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface RailSegment {
  id: string;
  properties: RailProperties;
  points: LonLat[];
  cumulative: number[];
  length: number;
  startNode: string;
  endNode: string;
}

export interface RailNode extends LonLat {
  id: string;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  segmentIds: string[];
}

export interface SnapResult {
  segmentId: string;
  offset: number;
  position: LonLat;
  distance: number;
}

/**
 * One selectable starting track in the station departure view.
 *
 * The geometry comes from the original OSM rail segments; the numbered tracks
 * are a UI grouping, not official track or platform numbering.
 */
export interface StationDepartureTrack {
  segmentId: string;
  name: string;
  /** Metres from the station coordinate to the nearest point on this track. */
  distance: number;
  /** Nearest offset along the original segment (the departure point). */
  offset: number;
  segmentLength: number;
  /** Coordinate-ascending tangent at the departure point. */
  heading: number;
  /** +1 when coordinate-ascending is the estimated up (toward Beijing) direction. */
  upSign: 1 | -1;
  /** Bearing of the estimated up direction at the departure point. */
  upBearing: number;
  bridge: boolean;
  tunnel: boolean;
  /** Local display polyline around the departure point. */
  points: LonLat[];
}

export interface StationDepartureContextTrack {
  segmentId: string;
  points: LonLat[];
}

export interface StationDeparture {
  station: Station;
  center: LonLat;
  /** Bearing from the station toward the up-direction reference (Beijing). */
  towardBeijing: number;
  tracks: StationDepartureTrack[];
  /** Display-only nearby geometry, including tracks beyond the selectable cap. */
  contextTracks: StationDepartureContextTrack[];
  radius: number;
  /** True when some nearby tracks were omitted from the selectable list. */
  truncated: boolean;
}

export interface RoutePoint extends LonLat {
  height: number;
  heading: number;
  travelled: number;
}

export interface JunctionOption {
  segmentId: string;
  name: string;
  bearing: number;
  direction: string;
  nextStation: string;
  angle: number;
  preview: LonLat[];
  previewLength: number;
  stopReason: string;
  confidence: 'derived' | 'uncertain';
  reason: string;
}

export interface JunctionContextTrack {
  segmentId: string;
  name: string;
  bridge: boolean;
  tunnel: boolean;
  points: LonLat[];
}

/** Static snapshot for the two-dimensional nearby-track map in the junction prompt. */
export interface JunctionContext {
  center: LonLat;
  /** Approach geometry ordered from behind the train toward the junction. */
  incoming: LonLat[];
  tracks: JunctionContextTrack[];
}

export interface JunctionRequest {
  nodeId: string;
  atSegmentEnd: boolean;
  options: JunctionOption[];
  currentName: string;
  incomingBearing: number;
  context: JunctionContext;
  diagnostics: unknown;
}

export type Reverser = -1 | 0 | 1;

export interface TrainState {
  velocity: number;
  throttle: number;
  brakeCommand: number;
  brakeActual: number;
  brakePipe: number;
  acceleration: number;
  tractionForce: number;
  brakeForce: number;
  resistanceForce: number;
  gradeForce: number;
  slope: number;
  reverser: Reverser;
  sandRemaining: number;
  adhesionLimited: boolean;
}

export interface SavePosition {
  province: string;
  segmentId: string;
  offset: number;
  direction: 1 | -1;
  travelled: number;
}

export interface GameSave {
  id: string;
  name: string;
  version: 1;
  savedAt: string;
  position: SavePosition;
  train: TrainState;
  elapsed: number;
  routeHistory: RoutePoint[];
  consist: typeof import('./config').APP_CONFIG.train.cars;
}

export interface StoredSettings {
  sound: boolean;
  autosave: boolean;
  cameraRange: number;
  renderRadius: number;
}

export function isStation(station: StationResult): station is Station & { pending?: false } {
  return !station.pending;
}
