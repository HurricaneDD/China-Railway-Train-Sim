import { APP_CONFIG } from '../config';
import type { LonLat, Station } from '../types';
import { distance } from '../utils/geo';

/** Keep labels short enough to stay readable without covering the map. */
export const STATION_LABEL_MAX_CHARS = 14;
/** Must match the Cesium label font size used by StationLabelRenderer. */
export const STATION_LABEL_FONT_SIZE = APP_CONFIG.stationLabels.fontSize;
export const STATION_LABEL_HEIGHT = APP_CONFIG.stationLabels.labelHeight;
export const STATION_LABEL_OFFSET_Y = APP_CONFIG.stationLabels.labelOffsetY;
const LABEL_HORIZONTAL_PADDING = 14;
const LABEL_GAP = 3;

export interface NearbyStation {
  station: Station;
  /** Metres from the supplied centre. */
  distance: number;
}

export interface StationScreenLabel {
  telecode: string;
  text: string;
  /** Screen anchor (the station point), in CSS pixels. */
  x: number;
  y: number;
  width: number;
  /** Lower values are considered first when labels overlap. */
  priority: number;
}

export interface StationLabelRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Read-only nearest-station query. It filters invalid coordinates, sorts by
 * true metres and caps the result before the renderer creates entities.
 */
export function nearbyStations(
  stations: readonly Station[],
  center: LonLat,
  radius: number,
  limit: number,
): NearbyStation[] {
  if (!(radius > 0) || limit <= 0) return [];
  const found: NearbyStation[] = [];
  for (const station of stations) {
    if (!Number.isFinite(station.longitude) || !Number.isFinite(station.latitude)) continue;
    const metres = distance(center, { lon: station.longitude, lat: station.latitude });
    if (metres <= radius) found.push({ station, distance: metres });
  }
  found.sort((a, b) => a.distance - b.distance || a.station.telecode.localeCompare(b.station.telecode));
  return found.slice(0, limit);
}

/** Station records do not include the trailing "站"; keep the display compact. */
export function stationLabelText(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > STATION_LABEL_MAX_CHARS
    ? `${trimmed.slice(0, STATION_LABEL_MAX_CHARS - 1)}…`
    : trimmed;
}

/** Conservative text width so collision checks do not depend on canvas metrics. */
export function stationLabelWidth(text: string): number {
  let em = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    // CJK and full-width punctuation are roughly one em; Latin/digits narrower.
    em += code >= 0x2e80 ? 1 : /[A-Za-z0-9]/.test(character) ? 0.62 : 0.46;
  }
  return Math.ceil(em * STATION_LABEL_FONT_SIZE + LABEL_HORIZONTAL_PADDING);
}

/** Screen box of the floating label above a station point. */
export function stationLabelRect(candidate: Pick<StationScreenLabel, 'x' | 'y' | 'width'>): StationLabelRect {
  return {
    left: candidate.x - candidate.width / 2,
    top: candidate.y - STATION_LABEL_OFFSET_Y - STATION_LABEL_HEIGHT,
    right: candidate.x + candidate.width / 2,
    bottom: candidate.y - STATION_LABEL_OFFSET_Y,
  };
}

function overlaps(a: StationLabelRect, b: StationLabelRect): boolean {
  return a.left < b.right + LABEL_GAP && a.right + LABEL_GAP > b.left
    && a.top < b.bottom + LABEL_GAP && a.bottom + LABEL_GAP > b.top;
}

/**
 * Greedy screen-space declutter for station labels. Cesium does not perform
 * collision avoidance for entity labels, and dense station clusters would
 * otherwise turn into unreadable overdraw. The input is already limited to
 * nearby stations by the caller.
 */
export function chooseStationLabels(
  candidates: readonly StationScreenLabel[],
  viewport: { width: number; height: number },
  maxLabels: number,
): string[] {
  if (maxLabels <= 0 || viewport.width <= 0 || viewport.height <= 0) return [];
  const ordered = [...candidates]
    .filter(candidate => Number.isFinite(candidate.x) && Number.isFinite(candidate.y) && candidate.width > 0)
    .sort((a, b) => a.priority - b.priority || a.telecode.localeCompare(b.telecode));
  const accepted: string[] = [];
  const boxes: StationLabelRect[] = [];
  for (const candidate of ordered) {
    if (accepted.length >= maxLabels) break;
    const rect = stationLabelRect(candidate);
    if (rect.right < 0 || rect.left > viewport.width || rect.bottom < 0 || rect.top > viewport.height) continue;
    if (boxes.some(box => overlaps(rect, box))) continue;
    accepted.push(candidate.telecode);
    boxes.push(rect);
  }
  return accepted;
}
