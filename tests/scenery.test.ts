import { Event, type Viewer } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { APP_CONFIG } from '../src/config';
import { ElevationService } from '../src/core/elevation';
import { GameSession } from '../src/core/session';
import { railHeight } from '../src/core/trackProfile';
import { SceneryManager } from '../src/map/SceneryManager';
import { hasDemoCatenary, planScenery, profilePoints } from '../src/map/sceneryPlan';
import { buildSceneryGeometry } from '../src/map/sceneryGeometry';
import type { RailSegment } from '../src/types';
import { distance, pointAt } from '../src/utils/geo';

vi.mock('cesium', async importOriginal => {
  const actual = await importOriginal<typeof import('cesium')>();
  return { ...actual, Primitive: class { ready = true; show = true; constructor(readonly options: unknown) {} } };
});
function track(id = 'main', lat = 32): RailSegment {
  const points = [0, 0.01, 0.02, 0.03, 0.04].map(x => ({ lon: 118 + x, lat }));
  const cumulative = [0];
  points.slice(1).forEach((p, i) => cumulative.push(cumulative[i] + distance(points[i], p)));
  return { id, points, cumulative, length: cumulative[4], startNode: 'a', endNode: 'b',
    properties: { name: 'test', province: 'test', osmId: id, layer: 0, bridge: false, tunnel: false } };
}
function setup() {
  const primitives = new Set();
  const postRender = new Event();
  const viewer = { isDestroyed: () => false, scene: {
    primitives: { add: (p: unknown) => primitives.add(p), remove: (p: unknown) => primitives.delete(p) },
    postRender, requestRender: () => queueMicrotask(() => postRender.raiseEvent()),
  } } as unknown as Viewer;
  const elevation = new ElevationService();
  return { manager: new SceneryManager(viewer, elevation), primitives, elevation };
}

describe('沿线场景分块与轨面', () => {
  it('前进跨越旧1.4km范围和倒车时保持本线覆盖，源坐标与chunk身份稳定', () => {
    const segment = track();
    const before = structuredClone(segment);
    const a = planScenery([segment], pointAt(segment, 1000), segment.id);
    const b = planScenery([segment], pointAt(segment, 1200), segment.id);
    expect(a.filter(c => b.some(d => d.key === c.key)).length).toBeGreaterThan(4);
    for (const offset of [0, 1300, 2700, 1300, segment.length]) {
      const plan = planScenery([segment], pointAt(segment, offset), segment.id);
      expect(plan.some(c => c.start <= offset && c.end >= offset)).toBe(true);
      expect(plan.every(c => c.start >= 0 && c.end <= segment.length)).toBe(true);
    }
    expect(segment).toEqual(before);
  });

  it('密集站场也优先本线；分岔另一路同时在范围内且数量有界', () => {
    const main = track('preferred');
    const others = Array.from({ length: 70 }, (_, i) => track(`yard-${i}`, 32 + i * 0.00003));
    const plan = planScenery([...others, main], pointAt(main, 1000), main.id);
    expect(plan).toHaveLength(APP_CONFIG.scenery.maxChunks);
    expect(plan[0].segment.id).toBe(main.id);
    expect(plan.filter(c => c.segment.id === main.id).length).toBeGreaterThan(4);
    expect(plan.some(c => c.segment.id !== main.id)).toBe(true);
  });

  it('邻块使用同一对原始高程插值，未知值不冒充零；不凭桥标签抬高', () => {
    const segment = track();
    const height = (p: { lon: number }) => (p.lon - 118) * 10000;
    const chunks = planScenery([segment], pointAt(segment, 500));
    const a = chunks.find(c => c.start === 250)!;
    const b = chunks.find(c => c.start === 500)!;
    expect(profilePoints(a).at(-1)).toEqual(profilePoints(b).at(-1));
    expect(railHeight(segment, 500, height)).toBeCloseTo(500 / segment.cumulative[1] * 100);
    expect(railHeight(segment, 500, () => undefined)).toBeUndefined();
    segment.properties.bridge = true;
    expect(railHeight(segment, 500, () => 20)).toBe(20);
  });

  it('仅显式样板范围显示演示接触网，几何为有限局部米制坐标', () => {
    const segment = track();
    const chunk = planScenery([segment], pointAt(segment, 500))[0];
    const geometry = buildSceneryGeometry(chunk, new ElevationService(), [segment]);
    expect(geometry.length).toBeGreaterThan(4);
    for (const instance of geometry) {
      const positions = (instance.geometry as any).attributes.position.values as Float64Array;
      expect([...positions].every(Number.isFinite)).toBe(true);
      expect(Math.max(...positions.map(Math.abs))).toBeLessThan(300);
    }
    expect(hasDemoCatenary(segment, { lon: 118.8, lat: 31.96 })).toBe(false);
    segment.properties.name = '京沪高铁';
    expect(hasDemoCatenary(segment, { lon: 118.8, lat: 31.96 })).toBe(true);
    expect(hasDemoCatenary(segment, { lon: 120, lat: 31.96 })).toBe(false);
    segment.properties.tunnel = true;
    expect(hasDemoCatenary(segment, { lon: 118.8, lat: 31.96 })).toBe(false);
  });

  it('列车和坡度读取同一轨面，倒车不翻转车体前向坡度；采样失败保留坡度', async () => {
    const segment = track();
    const session = new GameSession();
    session.railway.network.segments.set(segment.id, segment);
    session.position = { province: 'test', segmentId: segment.id, offset: 500, direction: 1, travelled: 0 };
    // 夹具坡度约 21‰，低于纵断面推定上限（40‰），保证拟合保留地形证据。
    vi.spyOn(session.elevation, 'height').mockImplementation(p => (p.lon - 118) * 2000);
    vi.spyOn(session.elevation, 'sample').mockResolvedValue([]);
    const refresh = () => (session as unknown as { refreshSlope(): Promise<void> }).refreshSlope();
    expect(session.currentPoint()!.height).toBeCloseTo(500 / segment.cumulative[1] * 20);
    await refresh();
    const forward = session.train.slope;
    expect(forward).toBeCloseTo(20 / segment.cumulative[1]);
    session.train.velocity = -10;
    await refresh();
    expect(session.train.slope).toBeCloseTo(forward);
    vi.spyOn(session.elevation, 'hasHeight').mockReturnValue(false);
    await refresh();
    expect(session.train.slope).toBeCloseTo(forward);
  });
});

describe('场景生命周期', () => {
  it('移动保留重叠块、释放远处块；倒车不增长缓存，clear完整释放', async () => {
    const { manager, primitives } = setup();
    const segment = track();
    await manager.update([segment], pointAt(segment, 500), segment.id);
    const first = new Set(primitives);
    await manager.update([segment], pointAt(segment, 750), segment.id);
    expect([...primitives].some(p => first.has(p))).toBe(true);
    for (const offset of [2000, 3200, 750]) {
      await manager.update([segment], pointAt(segment, offset), segment.id);
      expect(primitives.size).toBeLessThanOrEqual(APP_CONFIG.scenery.maxChunks);
      expect(manager.stats.staged).toBe(0);
    }
    manager.clear();
    expect(primitives.size).toBe(0);
  });

  it('高程失败保留旧场景并节流重试；clear隔离尚未完成的采样', async () => {
    const { manager, primitives, elevation } = setup();
    const segment = track();
    await manager.update([segment], pointAt(segment, 0), segment.id);
    const old = [...primitives];
    const known = vi.spyOn(elevation, 'hasHeight').mockReturnValue(false);
    await manager.update([segment], pointAt(segment, 3000), segment.id);
    expect([...primitives]).toEqual(old);
    expect(manager.stats.failed).toBe(true);
    expect(manager.needsUpdate(pointAt(segment, 3000), segment.id, 1, performance.now())).toBe(false);
    known.mockRestore();
    let resolve!: (values: number[]) => void;
    vi.spyOn(elevation, 'sample').mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const loading = manager.update([segment], pointAt(segment, 3000), segment.id);
    manager.clear();
    resolve([]);
    await loading;
    expect(primitives.size).toBe(0);
  });
});
