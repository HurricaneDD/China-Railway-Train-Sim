import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIT_OPTIONS,
  extrapolatePortalProfile,
  fillHeightGaps,
  fitTerrainProfile,
  interpolatePortalProfile,
  profileSampleAt,
  segmentSamplePoints,
  type HeightSample,
} from '../src/core/railProfile';
import { RailProfileService, type RailProfileNetwork } from '../src/core/railProfileService';
import type { LonLat, RailNode, RailProperties, RailSegment } from '../src/types';

/** 2‰ 基础坡道叠加 450 m 处 22 m 高斯鼓包，用于验证尖峰剔除。 */
function spikeTerrain(s: number): number {
  return 20 + 0.002 * s + 22 * Math.exp(-(((s - 450) / 45) ** 2));
}

function makeSegment(
  id: string, s0: number, s1: number, startNode: string, endNode: string,
  structured: Partial<RailProperties> = {},
): RailSegment {
  const lon0 = 118 + s0 / 100_000, lon1 = 118 + s1 / 100_000;
  const points = Array.from({ length: 11 }, (_, i) => ({ lon: lon0 + (lon1 - lon0) * i / 10, lat: 32 }));
  const length = s1 - s0;
  const cumulative = points.map((_, i) => (length * i) / 10);
  return {
    id,
    properties: { province: '320000', osmId: id, name: '', layer: 0, bridge: false, tunnel: false, ...structured },
    points, cumulative, length, startNode, endNode,
  };
}

function makeNode(id: string, segmentIds: string[]): RailNode {
  return { id, lon: 118, lat: 32, layer: 0, bridge: false, tunnel: false, segmentIds };
}

interface TestNetwork {
  network: RailProfileNetwork;
  sampledS: number[];
}

/** A—B—T(隧道)—D 沿经度排列；s 即 (lon−118)×100000，采样函数返回 spikeTerrain。 */
function makeLineNetwork(): TestNetwork {
  const segments = new Map<string, RailSegment>();
  const nodes = new Map<string, RailNode>();
  const add = (segment: RailSegment, nodesAt: Array<[string, string[]]>) => {
    segments.set(segment.id, segment);
    nodesAt.forEach(([nodeId, ids]) => nodes.set(nodeId, makeNode(nodeId, ids)));
  };
  add(makeSegment('t:A', 0, 900, 'n0', 'n1'), [['n0', ['t:A']], ['n1', ['t:A', 't:B']]]);
  add(makeSegment('t:B', 900, 1800, 'n1', 'n2'), [['n2', ['t:B', 't:T']]]);
  add(makeSegment('t:T', 1800, 2300, 'n2', 'n3', { tunnel: true }), [['n3', ['t:T', 't:D']]]);
  add(makeSegment('t:D', 2300, 3200, 'n3', 'n4'), [['n4', ['t:D']]]);
  const sampledS: number[] = [];
  return {
    network: { segments, nodes },
    sampledS,
  };
}

function samplerOf(state: TestNetwork, delay = 0) {
  return async (points: LonLat[]): Promise<Array<number | null>> => {
    const values = points.map(point => spikeTerrain((point.lon - 118) * 100_000));
    state.sampledS.push(...points.map(point => (point.lon - 118) * 100_000));
    if (delay) await new Promise(done => setTimeout(done, delay));
    return values;
  };
}

function uniformRaw(from: number, to: number, step: number, height: (s: number) => number | null): HeightSample[] {
  const count = Math.max(1, Math.ceil((to - from) / step));
  return Array.from({ length: count + 1 }, (_, i) => {
    const s = from + ((to - from) * i) / count;
    return { s, h: height(s) };
  });
}

describe('railProfile 拟合', () => {
  it('剔除顶点级 DEM 尖峰并满足推定坡度上限', () => {
    const raw = uniformRaw(0, 2000, 10, spikeTerrain);
    const fitted = fitTerrainProfile(raw, DEFAULT_FIT_OPTIONS);
    expect(fitted.samples.length).toBe(201);
    expect(fitted.confidence).toBe('inferred');
    expect(fitted.maxAbsGrade).toBeLessThanOrEqual(0.045);
    const atPeak = fitted.samples.find(point => Math.abs(point.s - 450) < 5)!;
    expect(atPeak.h).toBeLessThan(spikeTerrain(450) - 10);
    expect(Math.abs(fitted.samples[0].h! - spikeTerrain(0))).toBeLessThan(3);
    expect(fitted.samples.every(point => point.h !== null)).toBe(true);
  });

  it('可行锚点被精确保留，不可行锚点保留并输出冲突', () => {
    const raw = uniformRaw(0, 500, 10, s => 10 + 0.001 * s);
    const feasible = fitTerrainProfile(raw, DEFAULT_FIT_OPTIONS, { start: 10, end: 15 });
    expect(feasible.samples[0].h).toBe(10);
    expect(feasible.samples[feasible.samples.length - 1].h).toBe(15);
    expect(feasible.conflicts).toHaveLength(0);
    const infeasible = fitTerrainProfile(raw, DEFAULT_FIT_OPTIONS, { start: 10, end: 40 });
    expect(infeasible.samples[0].h).toBe(10);
    expect(infeasible.samples[infeasible.samples.length - 1].h).toBe(40);
    expect(infeasible.conflicts.length).toBeGreaterThan(0);
  });

  it('短缺口线性填补，中间长缺口跳过但端点缺测判为不可用', () => {
    const shortGap = uniformRaw(0, 500, 10, s => (s >= 200 && s < 250 ? null : 10 + 0.001 * s));
    const filled = fillHeightGaps(shortGap, DEFAULT_FIT_OPTIONS.maxFillGap);
    expect(filled.every(point => point.h !== null)).toBe(true);
    const fitted = fitTerrainProfile(shortGap, DEFAULT_FIT_OPTIONS);
    expect(fitted.samples.length).toBe(51);
    expect(fitted.confidence).toBe('inferred');
    const longGap = uniformRaw(0, 500, 10, s => (s >= 200 && s < 500 ? null : 10 + 0.001 * s));
    const refused = fitTerrainProfile(longGap, DEFAULT_FIT_OPTIONS);
    expect(refused.samples).toHaveLength(0);
    expect(refused.confidence).toBe('unknown');
    const midLongGap = uniformRaw(0, 500, 10, s => (s >= 200 && s < 500 - 100 ? null : 10 + 0.001 * s));
    const across = fitTerrainProfile(midLongGap, DEFAULT_FIT_OPTIONS);
    expect(across.samples.length).toBeGreaterThan(0);
    const heights = across.samples.map(point => point.h!);
    expect(heights.every(h => Number.isFinite(h))).toBe(true);
  });

  it('覆盖率不足时不可用', () => {
    const sparse = uniformRaw(0, 500, 10, s => (Math.round(s) % 40 === 0 ? 10 : null));
    const result = fitTerrainProfile(sparse, DEFAULT_FIT_OPTIONS);
    expect(result.samples).toHaveLength(0);
    expect(result.confidence).toBe('unknown');
  });

  it('densify 覆盖整段并包含精确端点', () => {
    const segment = makeSegment('t:geo', 0, 1234, 'a', 'b');
    const points = segmentSamplePoints(segment, 10);
    expect(points[0].s).toBe(0);
    expect(points[points.length - 1].s).toBeCloseTo(1234, 6);
    expect(points.length).toBe(125);
    expect(points[3].point.lat).toBe(32);
  });
});

describe('桥隧结构推定', () => {
  it('双端锚点线性插值，端点精确且坡度恒定', () => {
    const samples = interpolatePortalProfile(1000, 100, 120, 10);
    expect(samples[0].h).toBe(100);
    expect(samples[samples.length - 1].h).toBe(120);
    expect(profileSampleAt(samples, 500)!.height).toBeCloseTo(110, 9);
    expect(Math.abs(profileSampleAt(samples, 500)!.gradeForward)).toBeCloseTo(0.02, 9);
  });

  it('单端锚点按坡度延伸', () => {
    const samples = extrapolatePortalProfile(400, 50, 0.01, 10);
    expect(samples[0].h).toBe(50);
    expect(samples[samples.length - 1].h).toBeCloseTo(54, 9);
  });
});

describe('profileSampleAt 查询', () => {
  it('在样本间线性插值并在端点截断', () => {
    const samples = interpolatePortalProfile(100, 0, 10, 10);
    expect(profileSampleAt(samples, 45)!.height).toBeCloseTo(4.5, 9);
    expect(profileSampleAt(samples, -5)!.height).toBe(0);
    expect(profileSampleAt(samples, 500)!.height).toBe(10);
    expect(profileSampleAt([{ s: 0, h: 1 }], 0)).toBeUndefined();
  });
});

describe('RailProfileService 编排', () => {
  it('当前区段与相邻区段共享节点高程一致', async () => {
    const state = makeLineNetwork();
    const service = new RailProfileService({ network: state.network, sampleTerrain: samplerOf(state), densifyStep: 10 });
    await service.ensure('t:A');
    expect(service.sampleRailProfile('t:A', 450)).toBeDefined();
    expect(service.sampleRailProfile('t:B', 450)).toBeDefined();
    const aEnd = service.sampleRailProfile('t:A', 900)!.height;
    const bStart = service.sampleRailProfile('t:B', 0)!.height;
    expect(bStart).toBeCloseTo(aEnd, 6);
  });

  it('纵断面剔除尖峰且坡度受约束', async () => {
    const state = makeLineNetwork();
    const service = new RailProfileService({ network: state.network, sampleTerrain: samplerOf(state), densifyStep: 10 });
    await service.ensure('t:A');
    const mid = service.sampleRailProfile('t:A', 450)!;
    expect(mid.height).toBeLessThan(spikeTerrain(450) - 10);
    expect(Math.abs(mid.gradeForward)).toBeLessThanOrEqual(0.045);
    const diagnostics = service.diagnostics('t:A')!;
    expect(diagnostics.confidence).toBe('inferred');
    expect(diagnostics.maxAbsGrade).toBeLessThanOrEqual(0.045);
  });

  it('隧道不采样地形，用两端节点锚点插值', async () => {
    const state = makeLineNetwork();
    const service = new RailProfileService({ network: state.network, sampleTerrain: samplerOf(state), densifyStep: 10 });
    await service.ensure('t:T');
    const bEnd = service.sampleRailProfile('t:B', 900)!.height;
    const dStart = service.sampleRailProfile('t:D', 0)!.height;
    const tunnelStart = service.sampleRailProfile('t:T', 0)!;
    const tunnelEnd = service.sampleRailProfile('t:T', 500)!;
    expect(tunnelStart.height).toBeCloseTo(bEnd, 6);
    expect(tunnelEnd.height).toBeCloseTo(dStart, 6);
    expect(state.sampledS.filter(s => s > 1805 && s < 2295)).toHaveLength(0);
    expect(state.sampledS.some(s => s > 2295)).toBe(true);
  });

  it('单端锚点按入口坡度延伸并登记远端低可信高程', async () => {
    const segments = new Map<string, RailSegment>();
    const nodes = new Map<string, RailNode>();
    const e = makeSegment('t:E', 0, 800, 'm0', 'm1');
    const tunnel = makeSegment('t:T2', 800, 1300, 'm1', 'm2', { tunnel: true });
    segments.set('t:E', e);
    segments.set('t:T2', tunnel);
    nodes.set('m0', makeNode('m0', ['t:E']));
    nodes.set('m1', makeNode('m1', ['t:E', 't:T2']));
    nodes.set('m2', makeNode('m2', ['t:T2']));
    const sampledS: number[] = [];
    const service = new RailProfileService({
      network: { segments, nodes },
      sampleTerrain: samplerOf({ network: { segments, nodes }, sampledS }),
      densifyStep: 10,
    });
    await service.ensure('t:E');
    expect(service.sampleRailProfile('t:T2', 0)).toBeUndefined(); // 两端锚点均未就绪
    await service.ensure('t:T2');
    const far = service.sampleRailProfile('t:T2', 500)!;
    expect(far).toBeDefined();
    expect(service.diagnostics('t:T2')!.conflicts[0]).toContain('单端锚点');
    // 基础 2‰ 坡度从锚点延伸 500 m：20+1.6+1.0 ≈ 22.6；符号错误会得到 ≈20.6。
    expect(far.height).toBeGreaterThan(21.5);
    expect(far.height).toBeLessThan(24);
  });

  it('clear 后全部失效并可重建', async () => {
    const state = makeLineNetwork();
    const service = new RailProfileService({ network: state.network, sampleTerrain: samplerOf(state), densifyStep: 10 });
    await service.ensure('t:A');
    expect(service.sampleRailProfile('t:A', 100)).toBeDefined();
    service.clear();
    expect(service.sampleRailProfile('t:A', 100)).toBeUndefined();
    const before = state.sampledS.length;
    await service.ensure('t:A');
    expect(state.sampledS.length).toBeGreaterThan(before);
    expect(service.sampleRailProfile('t:A', 100)).toBeDefined();
  });

  it('构建跨越 provider 切换时不保留旧代数据', async () => {
    const state = makeLineNetwork();
    let release!: () => void;
    const gate = new Promise<void>(done => { release = done; });
    let switched = false;
    const service = new RailProfileService({
      network: state.network,
      sampleTerrain: async points => {
        const offset = switched ? -1000 : 0; // 偏移在调用时决定，模拟旧/新 provider
        await gate;
        return points.map(point => spikeTerrain((point.lon - 118) * 100_000) + offset);
      },
      densifyStep: 10,
    });
    const pending = service.ensure('t:A');
    service.clear();
    switched = true;
    release();
    await pending;
    const sample = service.sampleRailProfile('t:A', 100);
    expect(sample).toBeDefined();
    expect(sample!.height).toBeLessThan(-900); // 旧 provider 高程（约 +20）不得存活
    expect(sample!.revision).toBe(service.revision);
  });
});
