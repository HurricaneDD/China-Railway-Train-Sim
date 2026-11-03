import { describe, expect, it, vi } from 'vitest';
import { RailNetwork } from '../src/data/railway';
import { fetchJson } from '../src/utils/assets';
import type { ProvinceInfo } from '../src/types';
import { analyzeProvince } from '../dev/railway-check/analysis';

vi.mock('../src/utils/assets', () => ({ fetchJson: vi.fn() }));
const province = { adcode: '320000', province: '江苏省', file: 'x' } as ProvinceInfo;
const feature = (id: string, points: number[][], tags = {}) => ({ properties: { osm_id: id, code: 6101, layer: 0, bridge: 'F', tunnel: 'F', ...tags }, geometry: { type: 'MultiLineString', coordinates: [points] } });

async function load(features: ReturnType<typeof feature>[]) {
  vi.mocked(fetchJson).mockResolvedValue({ type: 'FeatureCollection', features });
  const graph = new RailNetwork();
  await graph.loadProvince(province);
  return { graph, analysis: analyzeProvince(graph, province.province) };
}

describe('线路人工检查诊断', () => {
  it('共享端点的桥隧与层级变化不产生被过滤断点', async () => {
    const { analysis } = await load([
      feature('ground', [[118, 32], [118.001, 32]]),
      feature('viaduct2', [[118.001, 32], [118.002, 32]], { bridge: 'T', layer: 2 }),
      feature('viaduct1', [[118.002, 32], [118.003, 32]], { bridge: 'T', layer: 1 }),
      feature('tunnel', [[118.003, 32], [118.004, 32]], { tunnel: 'T', layer: -1 }),
    ]);
    expect(analysis.stats.filteredGroups, '共享节点不应被桥隧属性切断').toBe(0);
    expect(analysis.stats.bridgeSegments).toBe(2);
    expect(analysis.stats.tunnelSegments).toBe(1);
    expect(analysis.groups.some(group => Math.abs(group.lon - 118.001) < 1e-9 && Math.abs(group.lat - 32) < 1e-9)).toBe(false);
  });

  it('0.55 米端点间隙会进入被过滤连接和断点列表', async () => {
    const { analysis } = await load([
      feature('main', [[118, 32], [118.001, 32]]),
      feature('offset', [[118.001, 32.000005], [118.002, 32.000005]]),
    ]);
    const group = analysis.groups.find(item => Math.abs(item.lon - 118.001) < 1e-9 && Math.abs(item.lat - 32) < 1e-9);
    expect(group).toMatchObject({ kind: 'filtered', severity: 'high' });
    expect(group!.candidates[0].reason).toContain('间隙');
    expect(analysis.filteredLinks.some(link => link.reason.includes('间隙'))).toBe(true);
    expect(analysis.stats.filteredLinks).toBeGreaterThan(0);
  });

  it('100 米内没有其它线路的端点标为孤立端点', async () => {
    const { analysis } = await load([
      feature('lonely', [[118, 32], [118.001, 32]]),
      feature('far', [[118, 32.01], [118.001, 32.01]]),
    ]);
    const group = analysis.groups.find(item => Math.abs(item.lon - 118.001) < 1e-9 && Math.abs(item.lat - 32) < 1e-9);
    expect(group).toMatchObject({ kind: 'isolated', severity: 'low' });
    expect(group!.nearest).toBeUndefined();
  });
});
