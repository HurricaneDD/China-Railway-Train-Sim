import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildStationDeparture, departureBearing, departureDirection, estimatedUpSign, trackWindow } from '../src/data/stationDeparture';
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

describe('车站始发站场与上行/下行推定', () => {
  it('按距站距离列出周边股道，并按朝向北京推定每条的上下行朝向', async () => {
    const network = await networkFrom([
      feature('ns', [[118, 31.995], [118, 32.005]], '南北线'),
      feature('rev', [[118.001, 32.005], [118.001, 31.995]], '反向线'),
      feature('ew', [[117.999, 31.999], [118.001, 31.999]], '东西线'),
      feature('far', [[118.03, 31.99], [118.03, 32.01]], '远线'),
    ]);
    const departure = buildStationDeparture(network, station);

    expect(departure.tracks.map(track => track.name)).toEqual(['南北线', '反向线', '东西线']);
    expect(departure.tracks.map(track => Math.round(track.distance))).toEqual([0, 94, 111]);
    expect(departure.contextTracks).toHaveLength(3);
    expect(departure.truncated).toBe(false);
    expect(departure.radius).toBe(1200);
    expect(departure.center).toEqual({ lon: 118, lat: 32 });

    const [north, reversed, eastWest] = departure.tracks;
    expect(north.upSign).toBe(1);
    expect(reversed.upSign).toBe(-1);
    // Beijing lies north-northwest of the fixture, so the up direction is westbound.
    expect(eastWest.upSign).toBe(-1);

    // The same physical up direction must map to different coordinate directions.
    expect(departureDirection(north, true)).toBe(1);
    expect(departureDirection(reversed, true)).toBe(-1);
    expect(departureBearing(north, true)).toBeCloseTo(0, 0);
    expect(departureBearing(reversed, true)).toBeCloseTo(0, 0);
    expect(departureBearing(north, false)).toBeCloseTo(180, 0);
    expect(departureDirection(north, false)).toBe(-1);
  });

  it('只截取出发股道附近的显示几何，不移动或改写原始坐标', async () => {
    const network = await networkFrom([feature('long', [[117.98, 32], [118.04, 32]])]);
    const departure = buildStationDeparture(network, station);
    const track = departure.tracks[0];
    const segment = network.segments.get(track.segmentId)!;
    const before = pointAt(segment, track.offset - 650);
    const after = pointAt(segment, track.offset + 650);
    expect(track.points[0].lon).toBeCloseTo(before.lon, 9);
    expect(track.points[0].lat).toBeCloseTo(before.lat, 9);
    expect(track.points.at(-1)!.lon).toBeCloseTo(after.lon, 9);
    expect(track.points.at(-1)!.lat).toBeCloseTo(after.lat, 9);
    expect(distance(track.points[0], track.points.at(-1)!)).toBeCloseTo(1300, -1);
    // The original segment is untouched.
    expect(segment.points).toHaveLength(2);
    expect(segment.points[1].lon).toBeCloseTo(118.04, 9);
  });

  it('股道数量超过上限时保留最近者并标记截断', async () => {
    const features = Array.from({ length: 65 }, (_, index) =>
      feature(`t${index}`, [[118 + index * 0.00005, 31.995], [118 + index * 0.00005, 32.005]]));
    const network = await networkFrom(features);
    const departure = buildStationDeparture(network, station);
    expect(departure.tracks).toHaveLength(60);
    expect(departure.truncated).toBe(true);
    expect(departure.tracks[0].distance).toBeCloseTo(0, 0);
  });

  it('窗口截取保留中间原始顶点，短于窗口时使用整段', () => {
    const points = [{ lon: 118, lat: 32 }, { lon: 118.02, lat: 32 }, { lon: 118.04, lat: 32 }];
    const cumulative = [0, distance(points[0], points[1])];
    cumulative.push(cumulative[1] + distance(points[1], points[2]));
    const segment: RailSegment = {
      id: 'x', points, cumulative, length: cumulative[2], startNode: 'a', endNode: 'b',
      properties: { osmId: 'x', province: '江苏省', name: '长线', layer: 0, bridge: false, tunnel: false },
    };
    const window = trackWindow(segment, 2000, 500);
    expect(window[0].lon).toBeCloseTo(pointAt(segment, 1500).lon, 9);
    expect(window.at(-1)!.lon).toBeCloseTo(pointAt(segment, 2500).lon, 9);
    expect(window.some(point => Math.abs(point.lon - 118.02) < 1e-9)).toBe(true);
    const whole = trackWindow(segment, 1000, 5000);
    expect(whole).toHaveLength(3);
  });

  it('方位推定以上行参考点为准，并给出可解释的上下行镜像', () => {
    const north = estimatedUpSign({ lon: 118, lat: 32 }, 0);
    expect(north).toBe(1);
    expect(estimatedUpSign({ lon: 118, lat: 32 }, 180)).toBe(-1);
    expect(estimatedUpSign({ lon: 118, lat: 32 }, 90)).toBe(-1);
    expect(estimatedUpSign({ lon: 118, lat: 32 }, 270)).toBe(1);
    expect(estimatedUpSign({ lon: 118, lat: 32 }, 348)).toBe(1);
    expect(estimatedUpSign({ lon: 118, lat: 32 }, 169)).toBe(-1);
  });
});

describe('从指定股道始发', () => {
  it('按所选上下行设置初始坐标方向与机车朝向，并保持驻车', () => {
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
    const start = session.startOnTrack(segment.id, 500, -1);
    expect(start.lat).toBeCloseTo(32 + 500 / 111195, 5);
    expect(session.position).toMatchObject({ province: '江苏省', segmentId: segment.id, offset: 500, direction: -1, travelled: 0 });
    expect(session.parkingBrake).toBe(true);
    expect(session.running).toBe(true);
    expect(session.train.brakeActual).toBe(100);
    expect(session.currentPoint()!.heading).toBeCloseTo(180, 3);
    session.stop();
  });

  it('拒绝不存在的股道，且不会破坏当前行程', () => {
    const session = new GameSession();
    expect(() => session.startOnTrack('missing', 0, 1)).toThrow('所选股道不存在');
    expect(session.position).toBeUndefined();
  });
});
