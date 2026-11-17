import { afterEach, describe, expect, it, vi } from 'vitest';
import { RailProfileService, type PersistedProfile, type RailProfileNetwork } from '../src/core/railProfileService';
import { railProfileStore, type PersistedRailProfile } from '../src/core/storage';
import type { LonLat, RailNode, RailSegment } from '../src/types';

function makeSegment(id: string, s0: number, s1: number, startNode: string, endNode: string): RailSegment {
  const lon0 = 118 + s0 / 100_000;
  const lon1 = 118 + s1 / 100_000;
  const points = Array.from({ length: 11 }, (_, i) => ({ lon: lon0 + ((lon1 - lon0) * i) / 10, lat: 32 }));
  const length = s1 - s0;
  const cumulative = points.map((_, i) => (length * i) / 10);
  return {
    id,
    properties: { province: '320000', osmId: id, name: '', layer: 0, bridge: false, tunnel: false },
    points,
    cumulative,
    length,
    startNode,
    endNode,
  };
}

function makeNode(id: string, segmentIds: string[]): RailNode {
  return { id, lon: 118, lat: 32, layer: 0, bridge: false, tunnel: false, segmentIds };
}

/** 单段 0–1000 m 平直区段；地形 = 20 + 0.002·s。 */
function makeNetwork(): { network: RailProfileNetwork; sampledS: number[] } {
  const segments = new Map<string, RailSegment>([['t:A', makeSegment('t:A', 0, 1000, 'n0', 'n1')]]);
  const nodes = new Map<string, RailNode>([
    ['n0', makeNode('n0', ['t:A'])],
    ['n1', makeNode('n1', ['t:A'])],
  ]);
  const sampledS: number[] = [];
  return { network: { segments, nodes }, sampledS };
}

function sampleTerrainOf(sampledS: number[]) {
  return async (points: LonLat[]) =>
    points.map((point) => {
      const s = (point.lon - 118) * 100_000;
      sampledS.push(s);
      return 20 + 0.002 * s;
    });
}

describe('纵断面持久化缓存', () => {
  it('首次构建采样并写入持久化；第二个实例命中缓存后不再采样', async () => {
    const saved = new Map<string, PersistedProfile>();
    const store = {
      load: async (segmentId: string): Promise<PersistedProfile | null> => saved.get(segmentId) ?? null,
      save: async (record: PersistedProfile) => {
        saved.set(record.segmentId, record);
      },
    };
    const first = makeNetwork();
    const service1 = new RailProfileService({ network: first.network, sampleTerrain: sampleTerrainOf(first.sampledS), persist: store });
    await service1.ensure('t:A');
    expect(first.sampledS.length).toBeGreaterThan(0);
    expect(saved.has('t:A')).toBe(true);

    const second = makeNetwork();
    const service2 = new RailProfileService({ network: second.network, sampleTerrain: sampleTerrainOf(second.sampledS), persist: store });
    await service2.ensure('t:A');
    expect(second.sampledS.length).toBe(0); // 没有任何地形采样
    const sample = service2.sampleRailProfile('t:A', 500);
    expect(sample).toBeDefined();
    expect(sample!.height).toBeCloseTo(20 + 0.002 * 500, 1);
    expect(sample!.gradeForward).toBeCloseTo(0.002, 4);
  });

  it('拟合参数指纹不匹配时丢弃旧记录重新采样', async () => {
    const saved = new Map<string, PersistedProfile>();
    const store = {
      load: async (segmentId: string): Promise<PersistedProfile | null> => saved.get(segmentId) ?? null,
      save: async (record: PersistedProfile) => {
        saved.set(record.segmentId, record);
      },
    };
    const first = makeNetwork();
    const service1 = new RailProfileService({ network: first.network, sampleTerrain: sampleTerrainOf(first.sampledS), persist: store, densifyStep: 10 });
    await service1.ensure('t:A');
    const second = makeNetwork();
    const service2 = new RailProfileService({ network: second.network, sampleTerrain: sampleTerrainOf(second.sampledS), persist: store, densifyStep: 25 });
    await service2.ensure('t:A');
    expect(second.sampledS.length).toBeGreaterThan(0); // 指纹不同，重新采样
  });

  it('持久化写入失败不影响剖面构建', async () => {
    const first = makeNetwork();
    const service = new RailProfileService({
      network: first.network,
      sampleTerrain: sampleTerrainOf(first.sampledS),
      persist: {
        load: async () => null,
        save: async () => {
          throw new Error('disk full');
        },
      },
    });
    await expect(service.ensure('t:A')).resolves.toBeUndefined();
    expect(service.sampleRailProfile('t:A', 0)).toBeDefined();
  });

  it('持久化读取失败时按未命中处理', async () => {
    const first = makeNetwork();
    const service = new RailProfileService({
      network: first.network,
      sampleTerrain: sampleTerrainOf(first.sampledS),
      persist: {
        load: async () => {
          throw new Error('db corrupt');
        },
        save: async () => undefined,
      },
    });
    await service.ensure('t:A');
    expect(first.sampledS.length).toBeGreaterThan(0);
  });
});

describe('railProfileStore（IndexedDB）', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('无 indexedDB 环境（Node 测试）时读写都是安全的空操作', async () => {
    await expect(railProfileStore.get('t:A')).resolves.toBeUndefined();
    await expect(railProfileStore.put({ segmentId: 't:A', samples: [], confidence: 'surveyed', coverage: 1, maxAbsGrade: 0, fitFingerprint: 'x', savedAt: '' })).resolves.toBeUndefined();
  });

  it('通过 stub 的 IndexedDB 完成 put/get 往返', async () => {
    const getRequest = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void) };
    const putRequest = { onsuccess: undefined as undefined | (() => void) };
    const get = vi.fn(() => getRequest);
    const put = vi.fn(() => putRequest);
    const store = { get, put };
    const tx = { objectStore: () => store, oncomplete: undefined as undefined | (() => void), onabort: undefined, onerror: undefined };
    const db = { transaction: () => tx, close: vi.fn() };
    const openRequest = { result: db, onsuccess: undefined as undefined | (() => void), onerror: null, onupgradeneeded: null };
    vi.stubGlobal('indexedDB', {
      open: () => {
        queueMicrotask(() => openRequest.onsuccess?.());
        return openRequest;
      },
    });
    const record: PersistedRailProfile = { segmentId: 't:A', samples: [{ s: 0, h: 20 }], confidence: 'surveyed', coverage: 1, maxAbsGrade: 0.002, fitFingerprint: 'f', savedAt: 'now' };
    const putPromise = railProfileStore.put(record);
    await vi.waitFor(() => expect(put).toHaveBeenCalled());
    putRequest.onsuccess?.();
    tx.oncomplete?.();
    await putPromise;
    const getPromise = railProfileStore.get('t:A');
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    getRequest.result = record;
    getRequest.onsuccess?.();
    tx.oncomplete?.();
    await expect(getPromise).resolves.toEqual(record);
  });
});
