import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameSession } from '../src/core/session';
import type { LonLat, RailSegment, SnapResult } from '../src/types';
import { distance, pointAt } from '../src/utils/geo';

// Synthetic branches exercise driving mechanics; they do not establish real route availability.
function branchedSession() {
  const session = new GameSession();
  const unit = 1 / 111195;
  function add(id: string, points: LonLat[], startNode: string, endNode: string) {
    const length = distance(points[0], points[1]);
    const segment: RailSegment = {
      id, points, cumulative: [0, length], length, startNode, endNode,
      properties: { osmId: id, province: '江苏省', name: id, layer: 0, bridge: false, tunnel: false },
    };
    session.railway.network.segments.set(id, segment);
    for (const [nodeId, point] of [[startNode, points[0]], [endNode, points[1]]] as [string, LonLat][]) {
      let node = session.railway.network.nodes.get(nodeId);
      if (!node) {
        node = { ...point, id: nodeId, layer: 0, bridge: false, tunnel: false, segmentIds: [] };
        session.railway.network.nodes.set(nodeId, node);
      }
      node.segmentIds.push(id);
    }
    return segment;
  }
  const a = add('A', [{ lon: 118, lat: 0 }, { lon: 118 + 1000 * unit, lat: 0 }], 'west', 'junction');
  const b = add('B', [a.points[1], { lon: 118 + 2000 * unit, lat: 0 }], 'junction', 'east');
  const c = add('C', [a.points[1], { lon: a.points[1].lon, lat: 1000 * unit }], 'junction', 'north');
  session.position = { province: '江苏省', segmentId: a.id, offset: 900, direction: 1, travelled: 0 };
  const internals = session as unknown as {
    initializeHistory(): void;
    advance(value: number): void;
    loadNearbyProvinces(force?: boolean): Promise<void>;
  };
  internals.initializeHistory();
  return { session, internals, a, b, c };
}

function chooseNamed(session: GameSession, name: string) {
  const option = session.junction?.options.find(candidate => candidate.name === name);
  expect(option, `应当提供 ${name} 的分岔选项`).toBeDefined();
  session.chooseJunction(option!.segmentId);
}

afterEach(() => vi.unstubAllGlobals());

describe('分岔改道与跨省恢复', () => {
  it('旧路线5米采样，折返后以0.17米微步选择新支线，车厢不会沿旧支线走', () => {
    const { session, internals, a, b, c } = branchedSession();
    let selectedB = false;
    // Approach the first branch through the actual advance/checkJunction path.
    for (let i = 0; i < 40; i++) {
      if (session.junction) { chooseNamed(session, b.id); selectedB = true; }
      internals.advance(5);
    }
    expect(selectedB).toBe(true);
    expect(session.position!.segmentId).toBe(b.id);

    session.setReverser(-1);
    for (let i = 0; i < 30; i++) internals.advance(-5);
    expect(session.position!.segmentId).toBe(a.id);
    expect(session.junction).toBeUndefined();

    session.setReverser(1);
    let selectedC = false;
    // A different sampling phase is essential: equal steps can accidentally overwrite old samples.
    for (let i = 0; i < 650; i++) {
      if (session.junction) { chooseNamed(session, c.id); selectedC = true; }
      internals.advance(0.17);
    }
    expect(selectedC).toBe(true);
    expect(session.position!.segmentId).toBe(c.id);
    expect(session.position!.offset).toBeGreaterThan(40);
    const points = session.consistPoints();
    expect(points).toHaveLength(5);
    expect(points[1].lon).toBeCloseTo(c.points[0].lon, 8);
    expect(points[1].lat).toBeGreaterThan(0);
    expect(points[1].heading).toBeCloseTo(0, 4);
    expect(distance(points[0], points[1])).toBeCloseTo(24, 1);
  });

  it('分岔提示保存附近配线图和接近节点，供二维地图绘制与点击选线', () => {
    const { session, internals, a, b, c } = branchedSession();
    vi.spyOn(session.railway.network, 'segmentsNear').mockReturnValue([a, b, c]);
    session.train.reverser = 1;
    session.train.velocity = 1;
    internals.advance(100);
    expect(session.junction).toBeDefined();
    expect(session.junction!.options).toHaveLength(2);
    expect(session.junction!.context.tracks.map(track => track.segmentId)).toEqual([a.id, b.id, c.id]);
    expect(session.junction!.context.incoming.length).toBeGreaterThan(2);
    const lastIncoming = session.junction!.context.incoming.at(-1)!;
    expect(lastIncoming.lon).toBeCloseTo(a.points[1].lon, 8);
    expect(lastIncoming.lat).toBeCloseTo(a.points[1].lat, 8);
    expect(session.junction!.context.center.lon).toBeCloseTo(a.points[1].lon, 8);
    expect(session.junction!.context.center.lat).toBeCloseTo(a.points[1].lat, 8);
    expect(session.railway.network.segmentsNear).toHaveBeenCalled();
  });

  it('旧行程慢速端点检查完成，不得锁住新行程的区段中段', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const { session, internals, b, c } = branchedSession();
    session.position!.segmentId = b.id;
    session.position!.offset = b.length;
    session.routeEnd = true;
    let resolveBorder!: () => void;
    const delayed = new Promise<void>(resolve => { resolveBorder = resolve; });
    vi.spyOn(internals, 'loadNearbyProvinces').mockReturnValue(delayed);
    const oldCheck = session.retryBorder();
    expect(session.loadingBorder).toBe(true);

    vi.spyOn(session.railway, 'load').mockResolvedValue();
    const point = pointAt(c, 200);
    vi.spyOn(session.railway.network, 'nearest').mockReturnValue({ segmentId: c.id, offset: 200, position: point, distance: 0 } as SnapResult);
    await session.startAt('江苏省', point, 2500);
    expect(session.loadingBorder).toBe(false);
    expect(session.routeEnd).toBe(false);
    resolveBorder();
    await oldCheck;
    expect(session.position!.segmentId).toBe(c.id);
    expect(session.position!.offset).toBeCloseTo(200);
    expect(session.routeEnd).toBe(false);
    expect(session.loadingBorder).toBe(false);
    session.stop();
  });

  it('前方线路重试只在端点得到真实出口后解锁，仍无出口时保持端点状态', async () => {
    const { session, internals, a, b } = branchedSession();
    session.position!.offset = a.length;
    session.routeEnd = true;
    vi.spyOn(internals, 'loadNearbyProvinces').mockResolvedValue();
    const realExits = session.railway.network.exitsAt.bind(session.railway.network);
    let loaded = false;
    vi.spyOn(session.railway.network, 'exitsAt').mockImplementation((...args) => loaded ? realExits(...args) : []);
    await session.retryBorder();
    expect(session.routeEnd).toBe(true);
    expect(session.loadingBorder).toBe(false);

    loaded = true;
    await session.retryBorder();
    expect(session.routeEnd).toBe(false);
    const boundary = session.railway.network.nextBoundary(a.id, a.length, 1)!;
    expect(session.railway.network.exitsAt(a.id, boundary, 1).some(exit => exit.segmentId === b.id)).toBe(true);
  });
});
