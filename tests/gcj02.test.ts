import { describe, expect, it } from 'vitest';
import { gcj02ToWgs84, isOutsideChina, wgs84ToGcj02 } from '../src/utils/gcj02';
import { distance } from '../src/utils/geo';

describe('WGS84 / GCJ-02 显示坐标转换', () => {
  it('广州南 WGS84 坐标转换为已知 GCJ-02 坐标', () => {
    const wgs84 = { lon: 113.263758, lat: 22.99113 };
    const gcj02 = wgs84ToGcj02(wgs84);
    // data/stations.json stores the same station's independently supplied GCJ-02 fields.
    expect(gcj02.lon).toBeCloseTo(113.26907794, 7);
    expect(gcj02.lat).toBeCloseTo(22.9883946, 7);
    expect(distance(wgs84, gcj02)).toBeGreaterThan(500);
  });

  it('GCJ-02 反算回 WGS84 的误差远小于瓦片分辨率', () => {
    const wgs84 = { lon: 116.3974, lat: 39.9093 };
    const restored = gcj02ToWgs84(wgs84ToGcj02(wgs84));
    expect(distance(wgs84, restored)).toBeLessThan(0.05);
  });

  it('中国范围外不做偏移', () => {
    const tokyo = { lon: 139.6917, lat: 35.6895 };
    expect(isOutsideChina(tokyo)).toBe(true);
    expect(wgs84ToGcj02(tokyo)).toEqual(tokyo);
    expect(gcj02ToWgs84(tokyo)).toEqual(tokyo);
  });
});
