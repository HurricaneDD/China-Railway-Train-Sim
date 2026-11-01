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
}

export interface JunctionRequest {
  nodeId: string;
  atSegmentEnd: boolean;
  options: JunctionOption[];
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
