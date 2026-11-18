import { describe, expect, it } from 'vitest';
import { directionalNearestStations } from '../src/core/nearbyStations';
import type { Station } from '../src/types';

const station = (name: string, longitude: number, latitude = 0) => ({ name, longitude, latitude }) as Station;
const stations = [station('西站', 117.99), station('东站', 118.01), station('更远东站', 118.02), station('侧向站', 118, 0.001), station('重合站', 118)];

describe('按接近与远离筛选最近站', () => {
  it('分别取两侧最近站，排除重合、侧向和无效坐标，距离以米计', () => {
    const result = directionalNearestStations([...stations, station('无效', NaN)], { lon: 118, lat: 0 }, 90);
    expect(result.next?.name).toBe('东站');
    expect(result.previous?.name).toBe('西站');
    expect(result.next?.distance).toBeCloseTo(1111.95, 1);
  });
  it('倒车交换接近与远离；经过站点后站点归入远离侧', () => {
    const reversed = directionalNearestStations(stations.slice(0, 3), { lon: 118, lat: 0 }, 270);
    expect(reversed.next?.name).toBe('西站');
    expect(reversed.previous?.name).toBe('东站');
    const passed = directionalNearestStations(stations.slice(0, 3), { lon: 118.011, lat: 0 }, 90);
    expect(passed.previous?.name).toBe('东站');
    expect(passed.next?.name).toBe('更远东站');
  });
  it('无站点或某一侧为空时不虚构车站', () => {
    expect(directionalNearestStations([], { lon: 118, lat: 0 }, 0)).toEqual({});
    expect(directionalNearestStations([station('东站', 118.01)], { lon: 118, lat: 0 }, 90).previous).toBeUndefined();
  });
});
