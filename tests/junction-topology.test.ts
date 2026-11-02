import { describe, expect, it, vi } from 'vitest';
import { RailNetwork } from '../src/data/railway';
import { fetchJson } from '../src/utils/assets';
import type { ProvinceInfo } from '../src/types';
import { readFileSync } from 'node:fs';
vi.mock('../src/utils/assets', () => ({ fetchJson: vi.fn() }));
const province = { adcode: '320000', province: '江苏省', file: 'x' } as ProvinceInfo;
const feature = (id: string, points: number[][], tags = {}) => ({ properties: { osm_id: id, code: 6101, layer: 0, bridge: 'F', tunnel: 'F', ...tags }, geometry: { type: 'MultiLineString', coordinates: [points] } });
async function network(features: ReturnType<typeof feature>[]) {
  vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features });
  const graph = new RailNetwork(); await graph.loadProvince(province); return graph;
}

describe('有向道岔与路径预览', () => {
  it('反向坐标直行仍通过，近180度回头被隔离，并可解释', async () => {
    const g = await network([
      feature('in', [[118, 32], [118.001, 32]]),
      feature('straight', [[118.002, 32], [118.001, 32]]),
      feature('wrong', [[118.001, 32], [118.0002, 32.00001]]),
      feature('left', [[118.001, 32], [118.002, 32.0004]]),
    ]);
    const boundary = g.nextBoundary('320000:0:0', 0, 1)!;
    const candidates = g.connectionsAt('320000:0:0', boundary, 1);
    expect(candidates.find(c => c.segmentId === '320000:1:0')!.angle).toBeCloseTo(0, 1);
    expect(candidates.find(c => c.segmentId === '320000:1:0')!.direction).toBe(-1);
    expect(candidates.find(c => c.segmentId === '320000:2:0')).toMatchObject({ valid: false, reason: '接近掉头，须停车换向' });
    expect(g.drivableExits('320000:0:0', boundary, 1)).toHaveLength(2);
    expect(candidates.find(c => c.segmentId === '320000:3:0')!.angle).toBeLessThan(0);
    const reverseBoundary = g.nextBoundary('320000:1:0', 0, 1)!;
    expect(g.drivableExits('320000:1:0', reverseBoundary, 1).some(c => c.segmentId === '320000:0:0')).toBe(true);
  });
  it('只允许吻合且走向连续的桥隧过渡，不把冲突层级转向视为道岔', async () => {
    const g = await network([
      feature('a', [[118, 32], [118.001, 32]]),
      feature('bridge', [[118.001, 32], [118.002, 32]], { bridge: 'T', layer: 1 }),
      feature('cross', [[118.001, 32], [118.001, 32.001]], { bridge: 'T', layer: 1 }),
      feature('crossing', [[118.0005, 31.999], [118.0005, 32.001]]),
    ]);
    const b = g.nextBoundary('320000:0:0', 0, 1)!;
    const all = g.connectionsAt('320000:0:0', b, 1);
    expect(all.find(c => c.segmentId === '320000:1:0')).toMatchObject({ valid: true, confidence: 'uncertain' });
    expect(all.find(c => c.segmentId === '320000:2:0')).toMatchObject({ valid: false });
    expect(all.some(c => c.segmentId === '320000:3:0')).toBe(false);
  });
  it('容差内但存在明显间隙的平行轨道不得自动接入', async () => {
    const g = await network([
      feature('a', [[118, 32], [118.001, 32]]),
      feature('parallel', [[118.001, 32.00001], [118.002, 32.00001]]),
    ]);
    const b = g.nextBoundary('320000:0:0', 0, 1)!;
    expect(g.connectionsAt('320000:0:0', b, 1)[0]).toMatchObject({ valid: false, reason: '端点存在间隙，无法确认物理连接' });
    expect(g.drivableExits('320000:0:0', b, 1)).toHaveLength(0);
  });
  it('内部顶点旁 0.1 米的侧线不冒充共享顶点，主线仍可续行', async () => {
    const g = await network([
      feature('main', [[118, 32], [118.001, 32], [118.002, 32]]),
      feature('side', [[118.001, 32.0000009], [118.002, 32.0000009]]),
    ]);
    const b = g.nextBoundary('320000:0:0', 0, 1)!;
    const candidates = g.connectionsAt('320000:0:0', b, 1);
    expect(candidates.find(c => c.segmentId === '320000:0:0')).toMatchObject({ valid: true });
    expect(candidates.find(c => c.segmentId === '320000:1:0')).toMatchObject({ valid: false, reason: '内部顶点与外部端点未重合，连接未确认' });
    expect(g.drivableExits('320000:0:0', b, 1).map(c => c.segmentId)).toEqual(['320000:0:0']);
  });
  it('5 米直桥两端的真实共享端点可继续通行', async () => {
    const x = 5 / (111195 * Math.cos(32 * Math.PI / 180));
    const g = await network([
      feature('ground', [[118, 32], [118.001, 32]]),
      feature('bridge', [[118.001, 32], [118.001 + x, 32]], { bridge: 'T', layer: 1 }),
      feature('ground2', [[118.001 + x, 32], [118.002, 32]]),
    ]);
    const a = g.nextBoundary('320000:0:0', 0, 1)!;
    const b = g.nextBoundary('320000:1:0', 0, 1)!;
    expect(g.drivableExits('320000:0:0', a, 1).map(c => c.segmentId)).toContain('320000:1:0');
    expect(g.drivableExits('320000:1:0', b, 1).map(c => c.segmentId)).toContain('320000:2:0');
  });
  it('预览跨唯一连接但在下一处分岔停止，不隐式选支线', async () => {
    const g = await network([
      feature('a', [[118, 32], [118.001, 32]]), feature('b', [[118.001, 32], [118.002, 32]]),
      feature('c', [[118.002, 32], [118.003, 32]]), feature('d', [[118.002, 32], [118.003, 32.0003]]),
    ]);
    const b = g.nextBoundary('320000:0:0', 0, 1)!;
    const first = g.drivableExits('320000:0:0', b, 1)[0];
    const preview = g.previewPath(first);
    expect(preview.stopReason).toBe('下一处分岔');
    expect(preview.points.at(-1)!.lon).toBeCloseTo(118.002, 6);
    expect(preview.length).toBeGreaterThan(90);
    expect(g.drivableExits('320000:0:0', b, 1)[0].key).toBe(first.key);
  });
  it('真实广州南周边候选可以逐项诊断和有界预览', async () => {
    const data = JSON.parse(readFileSync(new URL('../data/geojson/440000-广东省.geojson', import.meta.url), 'utf8'));
    vi.mocked(fetchJson).mockResolvedValue(data);
    const graph = new RailNetwork();
    await graph.loadProvince({ ...province, adcode: '440000', province: '广东省' });
    const stations = JSON.parse(readFileSync(new URL('../data/stations.json', import.meta.url), 'utf8')).stations;
    const station = stations.find((item: { name: string }) => item.name === '广州南');
    const nearby = graph.segmentsNear({ lon: station.longitude, lat: station.latitude }, 2500, 400);
    let branches = 0, invalid = 0, previews = 0;
    for (const segment of nearby) {
      for (const direction of [-1, 1] as const) {
        const boundary = graph.nextBoundary(segment.id, direction > 0 ? 0 : segment.length, direction)!;
        const all = graph.connectionsAt(segment.id, boundary, direction);
        invalid += all.filter(candidate => !candidate.valid).length;
        const valid = all.filter(candidate => candidate.valid);
        if (valid.length > 1) {
          branches++;
          for (const candidate of valid) {
            const preview = graph.previewPath(candidate);
            expect(preview.length).toBeLessThanOrEqual(2000);
            expect(preview.stopReason).toBeTruthy();
            previews++;
          }
        }
      }
    }
    console.log(`广州南 2.5km 抽样：${nearby.length} 区段，${branches} 个有向多出口边界，${invalid} 个隔离候选，${previews} 条预览`);
    expect(branches).toBeGreaterThan(0);
    expect(previews).toBeGreaterThan(1);
  });
});
