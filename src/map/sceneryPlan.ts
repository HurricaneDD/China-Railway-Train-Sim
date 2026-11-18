import { APP_CONFIG } from '../config';
import { railProfilePoints } from '../core/trackProfile';
import type { LonLat, RailSegment } from '../types';
import { nearestOnSegment, pointAt } from '../utils/geo';

export interface SceneryChunk {
  key: string;
  segment: RailSegment;
  start: number;
  end: number;
  distance: number;
}

/** Stable original-segment mileage, never a derived connection or a changed source coordinate. */
export function planScenery(segments: RailSegment[], focus: LonLat, preferred?: string): SceneryChunk[] {
  const config = APP_CONFIG.scenery;
  const chunks: SceneryChunk[] = [];
  for (const segment of segments) {
    const nearest = nearestOnSegment(segment, focus);
    if (!nearest || nearest.distance > config.radius) continue;
    const first = Math.max(0, Math.floor((nearest.offset - config.radius) / config.chunkLength));
    const last = Math.min(Math.ceil(segment.length / config.chunkLength) - 1,
      Math.floor((nearest.offset + config.radius) / config.chunkLength));
    for (let index = first; index <= last; index++) {
      const start = index * config.chunkLength;
      const end = Math.min(segment.length, start + config.chunkLength);
      const slice = sliceRail(segment, start, end);
      const near = nearestOnSegment(slice, focus);
      if (near && near.distance <= config.radius) chunks.push({
        key: `${segment.id}@${index}`, segment, start, end, distance: near.distance,
      });
    }
  }
  return chunks.sort((a, b) => {
    // Reserve continuous scenery on the player's track before spending the budget on a yard.
    const priority = Number(b.segment.id === preferred) - Number(a.segment.id === preferred);
    return priority || a.distance - b.distance || a.key.localeCompare(b.key);
  }).slice(0, config.maxChunks);
}

export function sliceRail(segment: RailSegment, start: number, end: number): RailSegment {
  const points: LonLat[] = [pointAt(segment, start)];
  const cumulative = [0];
  segment.points.forEach((point, index) => {
    if (segment.cumulative[index] > start && segment.cumulative[index] < end) {
      points.push(point);
      cumulative.push(segment.cumulative[index] - start);
    }
  });
  points.push(pointAt(segment, end));
  cumulative.push(end - start);
  return { ...segment, points, cumulative, length: end - start };
}

/** Include source vertices just outside the chunk: adjacent chunks interpolate the same profile. */
export function profilePoints(chunk: SceneryChunk): LonLat[] {
  return railProfilePoints(chunk.segment, chunk.start, chunk.end);
}

/** Optional visual treatment, explicitly limited to a Nanjing South demonstration corridor. */
export function hasDemoCatenary(segment: RailSegment, point: LonLat): boolean {
  return segment.properties?.name === '京沪高铁' && point.lon >= 118.74 && point.lon <= 118.84
    && point.lat >= 31.92 && point.lat <= 32.00 && !segment.properties.tunnel;
}
