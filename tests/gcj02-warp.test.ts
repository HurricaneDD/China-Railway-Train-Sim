import { Math as CesiumMath, WebMercatorTilingScheme } from 'cesium';
import { describe, expect, it } from 'vitest';
import { lonLatToTileFraction, planGcj02Warp, webMercatorTileBounds, WARP_TILE_SIZE } from '../src/map/gcj02Warp';
import { unprojectMercator } from '../src/utils/mercator';
import { wgs84ToGcj02 } from '../src/utils/gcj02';

const standard = new WebMercatorTilingScheme();

describe('Cesium 高德 GCJ-02 瓦片本地纠偏计划', () => {
  it('WGS84 瓦片边界与 Cesium 标准 Web Mercator 一致', () => {
    for (const [x, y, zoom] of [[4, 3, 3], [13598, 6655, 14], [26948, 13721, 15]]) {
      const bounds = webMercatorTileBounds(x, y, zoom);
      const expected = standard.tileXYToRectangle(x, y, zoom);
      expect(bounds.west).toBeCloseTo(CesiumMath.toDegrees(expected.west), 10);
      expect(bounds.south).toBeCloseTo(CesiumMath.toDegrees(expected.south), 10);
      expect(bounds.east).toBeCloseTo(CesiumMath.toDegrees(expected.east), 10);
      expect(bounds.north).toBeCloseTo(CesiumMath.toDegrees(expected.north), 10);
    }
  });

  it('瓦片中心映射到小数瓦片坐标 0.5', () => {
    const bounds = webMercatorTileBounds(13598, 6655, 14);
    const fraction = lonLatToTileFraction({ lon: (bounds.west + bounds.east) / 2, lat: (bounds.south + bounds.north) / 2 }, 14);
    expect(fraction.x).toBeCloseTo(13598.5, 3);
    expect(fraction.y).toBeCloseTo(6655.5, 3);
  });

  it('高缩放瓦片改用 GCJ-02 源瓦片，源瓦片范围覆盖目标中心', () => {
    const x = 217578;
    const y = 106478;
    const zoom = 18;
    const gcj = wgs84ToGcj02(unprojectMercator((x + 0.5) / 2 ** zoom, (y + 0.5) / 2 ** zoom));
    const fraction = lonLatToTileFraction(gcj, zoom);
    const plan = planGcj02Warp(x, y, zoom);
    expect(plan.sourceTiles).toContainEqual({ x: Math.floor(fraction.x), y: Math.floor(fraction.y) });
    expect(plan.offsetX).toBeCloseTo(WARP_TILE_SIZE / 2 - (fraction.x - plan.originX) * WARP_TILE_SIZE, 9);
    expect(plan.offsetY).toBeCloseTo(WARP_TILE_SIZE / 2 - (fraction.y - plan.originY) * WARP_TILE_SIZE, 9);
    expect(plan.sourceTiles.length).toBeLessThanOrEqual(4);
  });

  it('低缩放时整体偏移小于一个像素；中国境外保持恒等平移', () => {
    const x = 6;
    const y = 3;
    const zoom = 3;
    const plan = planGcj02Warp(x, y, zoom);
    expect(Math.abs(plan.offsetX)).toBeLessThanOrEqual(plan.sourceWidth);
    expect(Math.abs(plan.offsetY)).toBeLessThanOrEqual(plan.sourceHeight);

    const tokyo = planGcj02Warp(30, 12, 5);
    expect(tokyo.sourceTiles).toEqual([{ x: 30, y: 12 }]);
    expect(tokyo.offsetX).toBeCloseTo(0, 9);
    expect(tokyo.offsetY).toBeCloseTo(0, 9);
  });
});
