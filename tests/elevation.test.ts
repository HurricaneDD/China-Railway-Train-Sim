import { describe, expect, it, vi } from 'vitest';
import { sampleTerrainMostDetailed, type TerrainProvider } from 'cesium';
import { ElevationService } from '../src/core/elevation';

vi.mock('cesium', async importOriginal => {
  const actual = await importOriginal<typeof import('cesium')>();
  return { ...actual, sampleTerrainMostDetailed: vi.fn() };
});
const provider = () => ({ availability: {} }) as TerrainProvider;

describe('地形请求与降级', () => {
  it('采样超过6000个顶点，批次不超过100且相同点共享进行中的请求', async () => {
    vi.mocked(sampleTerrainMostDetailed).mockImplementation(async (_provider, points) => {
      points.forEach(point => { point.height = 50; });
      return points;
    });
    const elevation = new ElevationService();
    elevation.setProvider(provider());
    const points = Array.from({ length: 6100 }, (_, index) => ({ lon: 118 + index * 0.00002, lat: 32 }));
    const first = elevation.sample(points);
    const second = elevation.sample([points[0], points[6099]]);
    expect(await first).toEqual(Array(6100).fill(50));
    expect(await second).toEqual([50, 50]);
    expect(sampleTerrainMostDetailed).toHaveBeenCalledTimes(61);
    expect(vi.mocked(sampleTerrainMostDetailed).mock.calls.every(([, batch]) => batch.length <= 100)).toBe(true);
  });

  it('失败不写入假高程，重试和切换地形provider后可重新获取', async () => {
    vi.mocked(sampleTerrainMostDetailed).mockReset();
    const elevation = new ElevationService();
    elevation.setProvider(provider());
    const point = { lon: 118, lat: 32 };
    vi.mocked(sampleTerrainMostDetailed).mockRejectedValueOnce(new Error('offline'));
    expect(await elevation.sample([point])).toEqual([0]);
    vi.mocked(sampleTerrainMostDetailed).mockImplementation(async (_provider, points) => {
      points[0].height = 80;
      return points;
    });
    expect(await elevation.sample([point])).toEqual([80]);
    elevation.setProvider(provider());
    expect(elevation.height(point)).toBe(0);
    expect(await elevation.sample([point])).toEqual([80]);
  });

  it('超时后返回已有高程，允许后续重试', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sampleTerrainMostDetailed).mockReset();
      vi.mocked(sampleTerrainMostDetailed).mockImplementation(() => new Promise(() => {}));
      const elevation = new ElevationService();
      elevation.setProvider(provider());
      const sample = elevation.sample([{ lon: 118, lat: 32 }]);
      await vi.advanceTimersByTimeAsync(8001);
      expect(await sample).toEqual([0]);
      vi.mocked(sampleTerrainMostDetailed).mockImplementation(async (_provider, points) => {
        points[0].height = 30;
        return points;
      });
      expect(await elevation.sample([{ lon: 118, lat: 32 }])).toEqual([30]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('大量挂起批次的整次采样在12秒内结束，清理未启动任务且可重试', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sampleTerrainMostDetailed).mockReset();
      vi.mocked(sampleTerrainMostDetailed).mockImplementation(() => new Promise(() => {}));
      const elevation = new ElevationService();
      elevation.setProvider(provider());
      const points = Array.from({ length: 3000 }, (_, index) => ({ lon: 118 + index * 0.00002, lat: 32 }));
      let finished = false;
      const sample = elevation.sample(points).then(values => { finished = true; return values; });
      await vi.advanceTimersByTimeAsync(11_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(finished).toBe(true);
      expect(await sample).toEqual(Array(3000).fill(0));
      expect(elevation.hasHeight(points[2999])).toBe(false);
      // Only two waves of four requests started; the other 22 batches were released without I/O.
      expect(sampleTerrainMostDetailed).toHaveBeenCalledTimes(8);
      vi.mocked(sampleTerrainMostDetailed).mockImplementation(async (_provider, batch) => {
        batch.forEach(point => { point.height = 25; });
        return batch;
      });
      expect(await elevation.sample([points[0], points[2999]])).toEqual([25, 25]);
      expect(elevation.hasHeight(points[2999])).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('椭球地形直接使用零高程，不请求不可用的terrain availability', async () => {
    vi.mocked(sampleTerrainMostDetailed).mockReset();
    const elevation = new ElevationService();
    elevation.setProvider({} as TerrainProvider);
    expect(await elevation.sample([{ lon: 118, lat: 32 }])).toEqual([0]);
    expect(sampleTerrainMostDetailed).not.toHaveBeenCalled();
  });
});
