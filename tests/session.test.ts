import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSession } from '../src/core/session';
import { APP_CONFIG } from '../src/config';
import { distance } from '../src/utils/geo';
import type { LonLat, RailSegment } from '../src/types';

// Deterministic geometry fixtures, not evidence of real-world route availability.
function sessionOnLine(length = 3000, split = 1000, initialize = true) {
  const session = new GameSession();
  let previousNode = '';
  for (let i = 0; i < length / split; i++) {
    const points = [{ lon: 118 + i * split / 111195, lat: 0 }, { lon: 118 + (i + 1) * split / 111195, lat: 0 }];
    const startNode = previousNode || `n${i}`, endNode = `n${i + 1}`;
    const id = `320000:${i}:0`, segmentLength = distance(points[0], points[1]);
    const segment: RailSegment = { id, points, cumulative: [0, segmentLength], length: segmentLength, startNode, endNode,
      properties: { osmId: String(i), province: '江苏省', name: '测试线', layer: 0, bridge: false, tunnel: false } };
    session.railway.network.segments.set(id, segment);
    for (const [nodeId, point] of [[startNode, points[0]], [endNode, points[1]]] as [string, LonLat][]) {
      let node = session.railway.network.nodes.get(nodeId);
      if (!node) { node = { ...point, id: nodeId, layer: 0, bridge: false, tunnel: false, segmentIds: [] }; session.railway.network.nodes.set(nodeId, node); }
      node.segmentIds.push(id);
    }
    previousNode = endNode;
  }
  session.position = { province: '江苏省', segmentId: '320000:1:0', offset: 200, direction: 1, travelled: 0 };
  const internals = session as unknown as {
    advance(distance: number): void; initializeHistory(): void; tick(dt: number): void;
    refreshSlope(): Promise<void>; history: { travelled: number }[];
  };
  if (initialize) internals.initializeHistory();
  return { session, internals };
}

afterEach(() => vi.unstubAllGlobals());

describe('驾驶与编组', () => {
  it('60Hz微步推进100米，所有车厢保持配置间距', () => {
    const { session, internals } = sessionOnLine();
    const before = session.consistPoints();
    for (let i = 0; i < 600; i++) internals.advance(1 / 6);
    const after = session.consistPoints();
    expect(after).toHaveLength(5);
    after.forEach((point, index) => expect(distance(before[index], point)).toBeCloseTo(100, 1));
    expect(distance(after[0], after[1])).toBeCloseTo(24, 1);
    expect(internals.history.length).toBeGreaterThan(250);
  });

  it('前进30米再倒退15米，编组整体回退且机车朝向不随换向翻转', () => {
    const { session, internals } = sessionOnLine();
    internals.advance(30);
    const before = session.consistPoints();
    session.setReverser(-1);
    for (let i = 0; i < 90; i++) internals.advance(-1 / 6);
    const after = session.consistPoints();
    after.forEach((point, index) => expect(distance(before[index], point)).toBeCloseTo(15, 1));
    expect(after[0].heading).toBeCloseTo(before[0].heading);
    expect(session.position!.travelled).toBeCloseTo(45);
    expect(distance(after[0], after[1])).toBeCloseTo(24, 1);
  });

  it('倒车穿过区段起点继续向前一区段内部移动', () => {
    const { session, internals } = sessionOnLine();
    session.position!.offset = 1;
    internals.initializeHistory();
    internals.advance(-2);
    expect(session.position!.segmentId).toBe('320000:0:0');
    expect(session.position!.direction).toBe(1);
    expect(session.position!.offset).toBeCloseTo(session.railway.network.segments.get('320000:0:0')!.length - 1);
  });

  it('正反向坐标排列的短区段可以连续跨越', () => {
    const { session, internals } = sessionOnLine(300, 100, false);
    const reversed = session.railway.network.segments.get('320000:0:0')!;
    reversed.points.reverse();
    [reversed.startNode, reversed.endNode] = [reversed.endNode, reversed.startNode];
    session.position!.offset = 1;
    internals.initializeHistory();
    internals.advance(-30);
    expect(session.position!.segmentId).toBe(reversed.id);
    expect(session.position!.direction).toBe(-1);
    expect(session.position!.offset).toBeCloseTo(29);
  });

  it('单一连续的模拟线路跨区段行驶20km，不丢里程和编组间距', () => {
    const { session, internals } = sessionOnLine(30000);
    for (let i = 0; i < 120000; i++) internals.advance(1 / 6);
    expect(session.position!.travelled).toBeCloseTo(20000, 3);
    expect(session.position!.segmentId).toBe('320000:21:0');
    const points = session.consistPoints();
    expect(points).toHaveLength(5);
    expect(distance(points[0], points[1])).toBeCloseTo(24, 1);
  }, 15000);

  it('暂停时不推进，暂停释放牵引/制动按键', () => {
    const { session, internals } = sessionOnLine();
    session.holdThrottle('up', true);
    session.brakeHeld = true;
    session.setPaused(true);
    internals.tick(1);
    expect(session.elapsed).toBe(0);
    expect(session.position!.travelled).toBe(0);
    expect(session.brakeHeld).toBe(false);
    session.setPaused(false);
    internals.tick(1);
    expect(session.train.throttle).toBe(0);
  });

  it('存档恢复保留往返后的车体位置和车厢间距', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const first = sessionOnLine();
    first.internals.advance(30);
    first.internals.advance(-15);
    const save = first.session.createSave('往返');
    const next = sessionOnLine();
    vi.spyOn(next.session.railway, 'load').mockResolvedValue();
    await next.session.restore(save);
    expect(next.session.position!.travelled).toBeCloseTo(45);
    const original = first.session.consistPoints(), restored = next.session.consistPoints();
    restored.forEach((point, index) => expect(distance(original[index], point)).toBeLessThan(0.001));
    expect(restored).toHaveLength(5);
  });

  it('线路终点停车并解除牵引，给出明确终点状态', async () => {
    const { session, internals } = sessionOnLine();
    const segment = session.railway.network.segments.get('320000:2:0')!;
    session.position!.segmentId = segment.id;
    session.position!.offset = segment.length - 1;
    session.train.velocity = 10;
    session.train.throttle = 50;
    internals.advance(2);
    await Promise.resolve();
    await Promise.resolve();
    expect(session.train.velocity).toBe(0);
    expect(session.train.throttle).toBe(0);
    expect(session.routeEnd).toBe(true);
  });
});
