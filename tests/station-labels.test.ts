import { describe, expect, it } from 'vitest';
import type { Station } from '../src/types';
import { wgs84ToGcj02 } from '../src/utils/gcj02';
import { projectMercator, tileZoomForScale, WEB_MERCATOR_TILE_SIZE } from '../src/utils/mercator';
import { STATION_LABEL_MAX_CHARS, STATION_MIN_TILE_ZOOM, stationLabel, stationWorldPoints } from '../dev/railway-check/stationLabels';

const station = {
  telecode: 'NKH',
  name: '南京南',
  full_name: '南京南站',
  province: '江苏省',
  city: '南京市',
  city_raw: '南京市',
  address: null,
  longitude: 118.792817,
  latitude: 31.970649,
} as Station;

describe('检查页车站显示', () => {
  it('高德 GCJ-02 底图上的车站使用显示转换后的坐标', () => {
    const [projected] = stationWorldPoints([station], 'gcj02');
    const gcj = wgs84ToGcj02({ lon: station.longitude, lat: station.latitude });
    expect(projected.station).toBe(station);
    expect(projected.world.x).toBeCloseTo(projectMercator(gcj.lon, gcj.lat).x, 12);
    expect(projected.world.y).toBeCloseTo(projectMercator(gcj.lon, gcj.lat).y, 12);
    expect(projected.world.x).not.toBeCloseTo(projectMercator(station.longitude, station.latitude).x, 9);
  });

  it('WGS84 坐标系不做偏移，并过滤无有效坐标车站', () => {
    const invalid = { ...station, telecode: 'BAD', longitude: Number.NaN } as Station;
    const points = stationWorldPoints([station, invalid], 'wgs84');
    expect(points).toHaveLength(1);
    expect(points[0].world).toEqual(projectMercator(station.longitude, station.latitude));
  });

  it('站名长度受限，缩放阈值对应 12 级瓦片', () => {
    expect(stationLabel('南京南')).toBe('南京南');
    const longName = '这是一个超过十四字的超长车站名称';
    const label = stationLabel(longName);
    expect(label.length).toBeLessThanOrEqual(STATION_LABEL_MAX_CHARS);
    expect(label.endsWith('…')).toBe(true);
    expect(tileZoomForScale(WEB_MERCATOR_TILE_SIZE * 2 ** STATION_MIN_TILE_ZOOM)).toBe(STATION_MIN_TILE_ZOOM);
    expect(tileZoomForScale(WEB_MERCATOR_TILE_SIZE * 2 ** (STATION_MIN_TILE_ZOOM - 1))).toBe(STATION_MIN_TILE_ZOOM - 1);
  });
});
