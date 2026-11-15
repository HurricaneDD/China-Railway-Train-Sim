import { describe, expect, it } from 'vitest';
import { BASEMAPS, DEFAULT_MAP_TILES, MAP_TILE_OPTIONS } from '../dev/railway-check/basemap';
import { EARTH_CIRCUMFERENCE, metresPerWorldUnit, projectMercator, tileZoomForScale, unprojectMercator } from '../dev/railway-check/mercator';

describe('底图 WGS84 / Web Mercator 坐标与瓦片源', () => {
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

  it('Esri/OSM 瓦片为 WGS84，高德瓦片明确标记 GCJ-02', () => {
    expect(BASEMAPS.street.tileUrl(10, 845, 417)).toContain('World_Street_Map/MapServer/tile/10/417/845');
    expect(BASEMAPS.satellite.tileUrl(10, 845, 417)).toContain('World_Imagery/MapServer/tile/10/417/845');
    expect(BASEMAPS.street.attribution).toContain('OpenStreetMap');
    expect(BASEMAPS.plain.tileUrl(10, 845, 417)).toContain('tile.openstreetmap.org/10/845/417');
    expect(BASEMAPS.plain.attribution).toContain('OpenStreetMap');
    expect(BASEMAPS.satellite.attribution).toContain('Esri');
    expect(BASEMAPS.street.coordinateSystem).toBe('wgs84');
    expect(BASEMAPS.satellite.coordinateSystem).toBe('wgs84');
    expect(BASEMAPS['amap-street']).toMatchObject({ coordinateSystem: 'gcj02' });
    expect(BASEMAPS['amap-satellite']).toMatchObject({ coordinateSystem: 'gcj02' });
    expect(BASEMAPS['amap-hybrid']).toMatchObject({ coordinateSystem: 'gcj02' });
    expect(BASEMAPS['amap-street'].tileUrl(15, 26948, 13721)).toContain('webrd0');
    expect(BASEMAPS['amap-street'].tileUrl(15, 26948, 13721)).toContain('style=8');
    expect(BASEMAPS['amap-satellite'].tileUrl(15, 26948, 13721)).toContain('webst0');
    expect(BASEMAPS['amap-satellite'].attribution).toContain('高德');
    expect(BASEMAPS['amap-satellite'].tileUrlTemplate).toContain('style=6');
    expect(BASEMAPS['amap-hybrid'].tileUrlTemplate).toContain('style=6');
    expect(BASEMAPS['amap-hybrid'].overlayTileUrlTemplate).toContain('style=8');
  });

  it('三维地图瓦片默认高德卫星，并提供带路网选项', () => {
    expect(DEFAULT_MAP_TILES).toBe('amap-satellite');
    expect(MAP_TILE_OPTIONS[0].id).toBe('amap-satellite');
    expect(MAP_TILE_OPTIONS.map(option => option.id)).toEqual(['amap-satellite', 'amap-hybrid', 'amap-street', 'bing']);
  });
});
