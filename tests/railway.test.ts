import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { RailNetwork } from '../src/data/railway';
import { fetchJson } from '../src/utils/assets';
import type { ProvinceInfo } from '../src/types';

vi.mock('../src/utils/assets', () => ({ fetchJson: vi.fn() }));
const province = { adcode: '320000', province: '江苏省', file: 'geojson/320000-江苏省.geojson' } as ProvinceInfo;
const feature = (id: string, points: number[][], tags = {}) => ({
  properties: { osm_id: id, code: 6101, layer: 0, bridge: 'F', tunnel: 'F', ...tags },
  geometry: { type: 'MultiLineString', coordinates: [points] },
});

describe('按原始位置连接铁路', () => {
  it('跨桥隧和 layer 标签接续，但不连接只有中间相交的线', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [
      feature('1', [[118, 32], [118.001, 32]]),
      feature('2', [[118.001, 32], [118.002, 32]], { bridge: 'T', layer: 1 }),
      feature('3', [[118.002, 32], [118.003, 32]], { tunnel: 'T', layer: -1 }),
      feature('4', [[118.0005, 31.999], [118.0005, 32.001]]),
    ] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    expect(network.connections('320000:0:0', true).map(s => s.id)).toEqual(['320000:1:0']);
    expect(network.connections('320000:1:0', true).map(s => s.id)).toEqual(['320000:2:0']);
    expect(network.connections('320000:0:0', false)).toEqual([]);
    expect(network.connections('320000:3:0', true)).toEqual([]);
  });

  it('江苏真实数据载入保留每个有效 part 的全部原始坐标', async () => {
    const raw = JSON.parse(readFileSync(new URL('../data/geojson/320000-江苏省.geojson', import.meta.url), 'utf8'));
    vi.mocked(fetchJson).mockResolvedValue(raw);
    const network = new RailNetwork();
    await network.loadProvince(province);
    expect(network.segments.size).toBeGreaterThan(9000);
    for (const segment of network.segments.values()) {
      const [, featureIndex, partIndex] = segment.id.split(':').map(Number);
      expect(segment.points.map(p => [p.lon, p.lat])).toEqual(raw.features[featureIndex].geometry.coordinates[partIndex]);
    }
    const stations = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8')).stations;
    const nanjing = stations.find((s: { name: string }) => s.name === '南京南');
    expect(network.nearest({ lon: nanjing.longitude, lat: nanjing.latitude }, 2500)).not.toBeNull();
  });
});

describe('全国空间查询与跨省区段身份', () => {
  it('折线两端都在视野外时，仍能找到穿过视野的长边', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [feature('long', [[117, 32], [119, 32]])] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    expect(network.nearest({ lon: 118, lat: 32 }, 50)?.distance).toBeCloseTo(0);
    expect(network.segmentsNear({ lon: 118, lat: 32 }, 50).map(s => s.id)).toEqual(['320000:0:0']);
  });

  it('高纬度搜索按实际米制经度范围查询', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [feature('north', [[118.1501, 53.499], [118.1501, 53.501]])] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    const result = network.nearest({ lon: 118.0001, lat: 53.5 }, 10_000);
    expect(result).not.toBeNull();
    expect(result!.distance).toBeLessThan(10_000);
  });

  it('渲染按距离排序，并允许优先保留当前驾驶区段', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [
      feature('far', [[118.003, 31.999], [118.003, 32.001]]),
      feature('near', [[118, 31.999], [118, 32.001]]),
    ] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    expect(network.segmentsNear({ lon: 118, lat: 32 }, 1000, 1)[0].id).toBe('320000:1:0');
    expect(network.segmentsNear({ lon: 118, lat: 32 }, 1000, 1, '320000:0:0')[0].id).toBe('320000:0:0');
  });

  it('同一原始几何跨省重复时，两侧旧ID均可解析且不重复渲染', async () => {
    const duplicate = { type: 'FeatureCollection', features: [feature('same', [[118, 32], [118.001, 32]])] };
    const other = { ...province, adcode: '340000', province: '安徽省' };
    vi.mocked(fetchJson).mockResolvedValue(duplicate);
    for (const order of [[province, other], [other, province]]) {
      const network = new RailNetwork();
      for (const item of order) await network.loadProvince(item);
      expect(network.segments.size).toBe(1);
      expect(network.segments.has('320000:0:0')).toBe(true);
      expect(network.segments.get('320000:0:0')).toBe(network.segments.get('340000:0:0'));
      expect(network.connections('340000:0:0', true)).toEqual([]);
      expect(network.segmentsNear({ lon: 118, lat: 32 }, 1000)).toHaveLength(1);
    }
  });

  it('相同OSM ID的不同裁切部分均保留，不能按属性直接删掉几何', async () => {
    vi.mocked(fetchJson).mockResolvedValueOnce({ type: 'FeatureCollection', features: [feature('same', [[118, 32], [118.001, 32]])] })
      .mockResolvedValueOnce({ type: 'FeatureCollection', features: [feature('same', [[118.001, 32], [118.002, 32]])] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    await network.loadProvince({ ...province, adcode: '340000', province: '安徽省' });
    expect(network.segments.size).toBe(2);
    expect(network.connections('320000:0:0', true).map(s => s.id)).toEqual(['340000:0:0']);
  });
});

it('省份邻接覆盖现有33份数据，邻接对称且不虚构海南跨海连接', async () => {
  const { PROVINCE_NEIGHBORS, neighboringProvinces } = await import('../src/data/province-neighbors');
  const index = JSON.parse(readFileSync(new URL('../data/provinces_index.json', import.meta.url), 'utf8'));
  expect(Object.keys(PROVINCE_NEIGHBORS).sort()).toEqual(index.provinces.map((item: ProvinceInfo) => item.province).sort());
  for (const [provinceName, neighbors] of Object.entries(PROVINCE_NEIGHBORS)) {
    for (const neighbor of neighbors) expect(neighboringProvinces(neighbor)).toContain(provinceName);
  }
  expect(neighboringProvinces('江苏省')).toContain('上海市');
  expect(neighboringProvinces('海南省')).toEqual([]);
});

describe('原始共享顶点接续（不切分或改写原始区段）', () => {
  it('接入内部已有顶点时提供原线两个方向及支线出口，经过主线仍可直行', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [
      feature('main', [[118, 32], [118.001, 32], [118.002, 32]]),
      feature('branch', [[118.001, 31.999], [118.001, 32]]),
    ] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    const main = network.segments.get('320000:0:0')!, branch = network.segments.get('320000:1:0')!;
    const boundary = network.nextBoundary(main.id, 0, 1)!;
    expect(boundary.offset).toBe(main.cumulative[1]);
    expect(network.exitsAt(main.id, boundary, 1).map(exit => [exit.segmentId, exit.direction])).toEqual([[main.id, 1], [branch.id, -1]]);
    const branchEnd = network.nextBoundary(branch.id, 0, 1)!;
    expect(network.exitsAt(branch.id, branchEnd, 1).map(exit => [exit.segmentId, exit.direction])).toEqual([[main.id, -1], [main.id, 1]]);
    expect(network.nextBoundary(main.id, boundary.offset, 1)!.offset).toBe(main.length);
    expect(network.nextBoundary(main.id, boundary.offset, -1)!.offset).toBe(0);
    expect(main.points).toHaveLength(3);
    expect(network.segments.size).toBe(2);
  });

  it('没有原始共享顶点的折线中间交叉不擅自接通', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [
      feature('main', [[118, 32], [118.002, 32]]),
      feature('branch', [[118.001, 31.999], [118.001, 32]]),
    ] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    const main = network.segments.get('320000:0:0')!, branch = network.segments.get('320000:1:0')!;
    expect(network.nextBoundary(main.id, 0, 1)!.offset).toBe(main.length);
    expect(network.exitsAt(branch.id, network.nextBoundary(branch.id, 0, 1)!, 1)).toEqual([]);
  });

  it('跨省增量加载后，旧内部顶点与新端点双向接续，不依赖省份加载顺序', async () => {
    const a = { ...province, adcode: '320000' }, b = { ...province, adcode: '340000', province: '安徽省' };
    const mainData = { type: 'FeatureCollection', features: [feature('main', [[118, 32], [118.001, 32], [118.002, 32]])] };
    const branchData = { type: 'FeatureCollection', features: [feature('branch', [[118.001, 31.999], [118.001, 32]])] };
    for (const order of [[a, b], [b, a]]) {
      const network = new RailNetwork();
      for (const item of order) {
        vi.mocked(fetchJson).mockResolvedValue(item.adcode === '320000' ? mainData : branchData);
        await network.loadProvince(item);
        const segment = network.segments.get(`${item.adcode}:0:0`)!;
        network.nextBoundary(segment.id, 0, 1); // Force cache creation before loading the other province.
      }
      const boundary = network.nextBoundary('340000:0:0', 0, 1)!;
      expect(network.exitsAt('340000:0:0', boundary, 1).map(exit => [exit.segmentId, exit.direction])).toEqual([
        ['320000:0:0', -1], ['320000:0:0', 1],
      ]);
    }
  });

  it('同一原始闭合折线可以从末端接回自身起点', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features: [feature('loop', [[118, 32], [118.001, 32], [118.001, 32.001], [118, 32]])] });
    const network = new RailNetwork();
    await network.loadProvince(province);
    const segment = network.segments.get('320000:0:0')!;
    const end = network.nextBoundary(segment.id, 0, 1)!;
    expect(end.offset).toBe(segment.length);
    expect(network.exitsAt(segment.id, end, 1).map(exit => [exit.offset, exit.direction])).toEqual([[0, 1]]);
  });

  for (const example of [
    { adcode: '320000', province: '江苏省', terminalIndex: 6350, targetIndex: 432, vertex: 1 },
    { adcode: '440000', province: '广东省', terminalIndex: 11270, targetIndex: 2925, vertex: 2 },
    { adcode: '650000', province: '新疆维吾尔自治区', terminalIndex: 4654, targetIndex: 4653, vertex: 8 },
  ]) {
    it(`${example.province}真实断点按原始共享顶点接通`, async () => {
      const raw = JSON.parse(readFileSync(new URL(`../data/geojson/${example.adcode}-${example.province}.geojson`, import.meta.url), 'utf8'));
      vi.mocked(fetchJson).mockResolvedValue(raw);
      const network = new RailNetwork();
      await network.loadProvince({ ...province, adcode: example.adcode, province: example.province });
      const terminal = network.segments.get(`${example.adcode}:${example.terminalIndex}:0`)!;
      const target = network.segments.get(`${example.adcode}:${example.targetIndex}:0`)!;
      const boundary = network.nextBoundary(terminal.id, terminal.length - 0.1, 1)!;
      const exits = network.exitsAt(terminal.id, boundary, 1).filter(exit => exit.segmentId === target.id);
      expect(exits.map(exit => exit.direction)).toEqual([-1, 1]);
      expect(exits.every(exit => exit.offset === target.cumulative[example.vertex])).toBe(true);
      expect(target.points.map(point => [point.lon, point.lat])).toEqual(raw.features[example.targetIndex].geometry.coordinates[0]);
    });
  }
});
