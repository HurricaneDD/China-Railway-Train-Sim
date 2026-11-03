import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStationDeparture, lineBearing, lineWindow } from '../src/data/stationDeparture';
import { RailNetwork } from '../src/data/railway';
import { GameSession } from '../src/core/session';
import type { ProvinceInfo, RailSegment, Station } from '../src/types';
import { distance, pointAt } from '../src/utils/geo';

const province = { adcode: '320000', province: '江苏省', file: 'geojson/320000-江苏省.geojson' } as ProvinceInfo;
const station: Station = {
  telecode: 'TST', name: '测试站', full_name: '测试站', province: '江苏省', city: '测试市', city_raw: '',
  address: null, lon: 118, lat: 32, longitude: 118, latitude: 32,
};

const feature = (id: string, points: number[][], name = `线路-${id}`) => ({
  properties: { osm_id: id, code: 6101, layer: 0, bridge: 'F', tunnel: 'F', name },
  geometry: { type: 'MultiLineString', coordinates: [points] },
});

async function networkFrom(features: unknown[]): Promise<RailNetwork> {
  const network = new RailNetwork(async <T>() => ({ type: 'FeatureCollection', features }) as T);
  await network.loadProvince(province);
  return network;
}

afterEach(() => vi.unstubAllGlobals());

describe('车站始发线路快照', () => {
  it('按距站距离列出线路，只截取局部显示几何，且不触发全网络拓扑', async () => {
    const network = await networkFrom([
      feature('ns', [[118, 31.995], [118, 32.005]], '南北线'),
      feature('rev', [[118.001, 32.005], [118.001, 31.995]], '反向线'),
      feature('far', [[118.03, 31.99], [118.03, 32.01]], '远线'),
    ]);
    // Selecting a station must stay a local operation; any topology query would be a regression.
    const topology = vi.spyOn(network, 'nextBoundary').mockImplementation(() => { throw new Error('topology must not run'); });
    const departures = vi.spyOn(network, 'drivableExits').mockImplementation(() => { throw new Error('topology must not run'); });
    const snapshot = buildStationDeparture(network, station);

    expect(snapshot.lines.map(line => line.name)).toEqual(['南北线', '反向线']);
    expect(snapshot.lines.map(line => Math.round(line.distance))).toEqual([0, 94]);
    expect(snapshot.center).toEqual({ lon: 118, lat: 32 });
    expect(snapshot.radius).toBe(1500);
    expect(snapshot.truncated).toBe(false);
    expect(topology).not.toHaveBeenCalled();
    expect(departures).not.toHaveBeenCalled();
    expect(snapshot.lines[0].points.length).toBeGreaterThanOrEqual(2);
  });

  it('方向沿原始坐标前进/后退，返回可读的地理方位', async () => {
    const network = await networkFrom([feature('ns', [[118, 31.995], [118, 32.005]])]);
    const line = buildStationDeparture(network, station).lines[0];
    expect(lineBearing(line, 1)).toBeCloseTo(0, 1);
    expect(lineBearing(line, -1)).toBeCloseTo(180, 1);
  });

  it('窗口只截取出发线路附近，不移动原始坐标', () => {
    const points = [{ lon: 118, lat: 32 }, { lon: 118.02, lat: 32 }, { lon: 118.04, lat: 32 }];
    const cumulative = [0, distance(points[0], points[1])];
    cumulative.push(cumulative[1] + distance(points[1], points[2]));
    const segment: RailSegment = {
      id: 'x', points, cumulative, length: cumulative[2], startNode: 'a', endNode: 'b',
      properties: { osmId: 'x', province: '江苏省', name: '长线', layer: 0, bridge: false, tunnel: false },
    };
    const window = lineWindow(segment, 2000, 500);
    expect(window[0].lon).toBeCloseTo(pointAt(segment, 1500).lon, 9);
    expect(window.at(-1)!.lon).toBeCloseTo(pointAt(segment, 2500).lon, 9);
    expect(segment.points).toHaveLength(3);
  });
});

describe('从所选线路始发', () => {
  it('按方向设置坐标朝向和机车朝向，并保持驻车', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const session = new GameSession();
    const points = [{ lon: 118, lat: 32 }, { lon: 118, lat: 32.01 }];
    const length = distance(points[0], points[1]);
    const segment: RailSegment = {
      id: '320000:0:0', points, cumulative: [0, length], length, startNode: 's', endNode: 'e',
      properties: { osmId: '0', province: '江苏省', name: '测试线', layer: 0, bridge: false, tunnel: false },
    };
    session.railway.network.segments.set(segment.id, segment);
    session.startOnTrack(segment.id, 500, -1);
    expect(session.position).toMatchObject({ province: '江苏省', segmentId: segment.id, offset: 500, direction: -1, travelled: 0 });
    expect(session.parkingBrake).toBe(true);
    expect(session.running).toBe(true);
    expect(session.currentPoint()!.heading).toBeCloseTo(180, 3);
    session.stop();
  });

  it('拒绝不存在的线路，不破坏当前位置', () => {
    const session = new GameSession();
    expect(() => session.startOnTrack('missing', 0, 1)).toThrow('所选始发线路不存在');
    expect(session.position).toBeUndefined();
  });
});
