import { describe, expect, it } from 'vitest';
import { distance, nearestOnSegment, projectToSegment } from '../src/utils/geo';
import type { RailSegment } from '../src/types';

describe('铁路几何', () => {
  it('将点投影到线段而非仅选择顶点', () => {
    const projected = projectToSegment({ lon: 116, lat: 39.5 }, { lon: 115.9, lat: 39.5 }, { lon: 116.1, lat: 39.5 });
    expect(projected.fraction).toBeCloseTo(0.5);
    expect(projected.position.lon).toBeCloseTo(116);
    expect(projected.distance).toBeLessThan(0.01);
  });

  it('最近点包含正确的区段里程', () => {
    const segment: RailSegment = {
      id: 'test', properties: { province: '测试', osmId: '1', name: '测试线', layer: 0, bridge: false, tunnel: false },
      points: [{ lon: 116, lat: 40 }, { lon: 116.1, lat: 40 }], cumulative: [], length: 0, startNode: '', endNode: '',
    };
    segment.length = distance(segment.points[0], segment.points[1]);
    segment.cumulative = [0, segment.length];
    const result = nearestOnSegment(segment, { lon: 116.025, lat: 40.001 });
    expect(result).not.toBeNull();
    expect(result!.offset / segment.length).toBeCloseTo(0.25, 1);
  });
});
