import { describe, expect, it } from 'vitest';
import { closestScreenPath, fitLonLatPaths, panViewBy, pointAtPathFraction, screenOf, zoomViewAt, type ScreenPath } from '../src/map/junctionMap';

describe('道岔二维配线图视图与点击选择', () => {
  it('将完整候选路径等比放入画布，所有点都留在内边距内', () => {
    const paths = [
      [{ lon: 113.25, lat: 22.98 }, { lon: 113.27, lat: 23.00 }],
      [{ lon: 113.25, lat: 22.98 }, { lon: 113.28, lat: 22.97 }, { lon: 113.29, lat: 22.99 }],
    ];
    const view = fitLonLatPaths(paths, 800, 500, 40)!;
    expect(view).toBeDefined();
    expect(view.scale).toBeGreaterThan(0);
    const screen = paths.flat().map(point => screenOf(point, view, 800, 500));
    for (const point of screen) {
      expect(point.x).toBeGreaterThanOrEqual(39);
      expect(point.x).toBeLessThanOrEqual(761);
      expect(point.y).toBeGreaterThanOrEqual(39);
      expect(point.y).toBeLessThanOrEqual(461);
    }
    // Uniform scale: the bounding box is centred, not stretched independently per axis.
    const minX = Math.min(...screen.map(point => point.x));
    const maxX = Math.max(...screen.map(point => point.x));
    const minY = Math.min(...screen.map(point => point.y));
    const maxY = Math.max(...screen.map(point => point.y));
    expect((minX + maxX) / 2).toBeCloseTo(400, 5);
    expect((minY + maxY) / 2).toBeCloseTo(250, 5);
  });

  it('点击坐标吸附到阈值内最近的候选线，不命中过远的线', () => {
    const paths: ScreenPath[] = [
      { id: 'left', points: [{ x: 20, y: 20 }, { x: 120, y: 20 }] },
      { id: 'right', points: [{ x: 20, y: 60 }, { x: 120, y: 60 }] },
    ];
    expect(closestScreenPath(paths, 70, 64, 10)).toBe('right');
    expect(closestScreenPath(paths, 70, 44, 10)).toBeUndefined();
    expect(closestScreenPath(paths, 70, 80, 10)).toBeUndefined();
  });

  it('沿折线长度取点，用于绘制序号和方向箭头', () => {
    const path: ScreenPath = { id: 'bend', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] };
    expect(pointAtPathFraction(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtPathFraction(path, 0.25).x).toBeCloseTo(50, 5);
    expect(pointAtPathFraction(path, 0.25).y).toBeCloseTo(0, 5);
    expect(pointAtPathFraction(path, 0.75).x).toBeCloseTo(100, 5);
    expect(pointAtPathFraction(path, 0.75).y).toBeCloseTo(50, 5);
    expect(pointAtPathFraction(path, 1)).toEqual({ x: 100, y: 100 });
  });

  it('滚轮缩放锚定光标位置，并受最小/最大比例限制；拖拽平移按像素比例换算', () => {
    const view = fitLonLatPaths([[{ lon: 118, lat: 32 }, { lon: 118.005, lat: 32.005 }]], 800, 500, 40)!;
    const anchoredWorld = { x: view.cx + (200 - 400) / view.scale, y: view.cy + (150 - 250) / view.scale };
    const zoomed = zoomViewAt(view, 800, 500, 200, 150, 2, view.scale * 0.5, view.scale * 8);
    expect(zoomed.scale).toBeCloseTo(view.scale * 2, 8);
    expect(zoomed.cx + (200 - 400) / zoomed.scale).toBeCloseTo(anchoredWorld.x, 12);
    expect(zoomed.cy + (150 - 250) / zoomed.scale).toBeCloseTo(anchoredWorld.y, 12);
    expect(zoomViewAt(view, 800, 500, 400, 250, 99, view.scale * 0.5, view.scale * 8).scale).toBeCloseTo(view.scale * 8, 8);
    expect(zoomViewAt(view, 800, 500, 400, 250, 0.001, view.scale * 0.5, view.scale * 8).scale).toBeCloseTo(view.scale * 0.5, 8);
    const panned = panViewBy(view, 80, -50);
    expect(panned.cx).toBeCloseTo(view.cx - 80 / view.scale, 12);
    expect(panned.cy).toBeCloseTo(view.cy + 50 / view.scale, 12);
    expect(panned.scale).toBe(view.scale);
  });
});
