import { describe, expect, it } from 'vitest';
import { BASEMAPS } from '../dev/railway-check/basemap';
import { EARTH_CIRCUMFERENCE, metresPerWorldUnit, projectMercator, tileZoomForScale, unprojectMercator } from '../dev/railway-check/mercator';

describe('检查页 WGS84 / Web Mercator 底图坐标', () => {
  it('WGS84 经纬度经过 Web Mercator 往返不改变', () => {
    for (const [lon, lat] of [[118.7969, 32.0603], [116.4074, 39.9042], [87.6168, 43.8256], [0, 0], [-180, -60]]) {
      const projected = projectMercator(lon, lat);
      const restored = unprojectMercator(projected.x, projected.y);
      expect(restored.lon).toBeCloseTo(lon, 10);
      expect(restored.lat).toBeCloseTo(lat, 10);
    }
  });

  it('本初子午线与赤道映射到世界中心，极区被截断', () => {
    const centre = projectMercator(0, 0);
    expect(centre.x).toBeCloseTo(0.5, 12);
    expect(centre.y).toBeCloseTo(0.5, 12);
    expect(projectMercator(0, 90).y).toBeCloseTo(projectMercator(0, 85.05112878).y, 8);
    expect(projectMercator(0, -90).y).toBeCloseTo(projectMercator(0, -85.05112878).y, 8);
  });

  it('底图缩放级别和米制比例按 Web Mercator 计算', () => {
    expect(tileZoomForScale(256, 2, 20)).toBe(2);
    expect(tileZoomForScale(256 * 2 ** 10, 2, 20)).toBe(10);
    expect(tileZoomForScale(10, 2, 20)).toBe(2);
    expect(tileZoomForScale(256 * 2 ** 30, 2, 20)).toBe(20);
    expect(metresPerWorldUnit(0)).toBeCloseTo(EARTH_CIRCUMFERENCE, 6);
    expect(metresPerWorldUnit(60)).toBeCloseTo(EARTH_CIRCUMFERENCE / 2, 3);
  });

  it('底图使用标准 WGS84 Web Mercator 瓦片，而不是 GCJ-02 互联网地图', () => {
    expect(BASEMAPS.street.tileUrl(10, 845, 417)).toContain('World_Street_Map/MapServer/tile/10/417/845');
    expect(BASEMAPS.satellite.tileUrl(10, 845, 417)).toContain('World_Imagery/MapServer/tile/10/417/845');
    expect(BASEMAPS.street.attribution).toContain('OpenStreetMap');
    expect(BASEMAPS.satellite.attribution).toContain('Esri');
  });
});
