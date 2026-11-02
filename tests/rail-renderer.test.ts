import { Event, type Viewer } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { RailRenderer } from '../src/map/RailRenderer';
import type { ElevationService } from '../src/core/elevation';
import type { RailSegment } from '../src/types';

vi.mock('cesium', async importOriginal => {
  const actual = await importOriginal<typeof import('cesium')>();
  return { ...actual, Primitive: class { ready = true; constructor(readonly options: unknown) {} } };
});

const segment = {
  id: 'track', points: [{ lon: 118, lat: 32 }, { lon: 118.001, lat: 32 }],
  cumulative: [0, 95], length: 95,
} as RailSegment;
function setup() {
  const primitives = new Set();
  const postRender = new Event();
  const viewer = {
    isDestroyed: () => false,
    scene: {
      primitives: { add: (p: unknown) => primitives.add(p), remove: (p: unknown) => primitives.delete(p) },
      postRender, requestRender: () => queueMicrotask(() => postRender.raiseEvent()),
    },
  } as unknown as Viewer;
  const sample = vi.fn(async () => [] as number[]);
  const hasHeight = vi.fn(() => true);
  const renderer = new RailRenderer(viewer, { sample, height: () => 20, hasHeight } as unknown as ElevationService);
  return { renderer, primitives, sample, hasHeight };
}

describe('轨道异步替换', () => {
  it('新地形采样期间保留旧轨道，新图ready后整体替换', async () => {
    const { renderer, primitives, sample } = setup();
    await renderer.render([segment]);
    const old = [...primitives];
    let resolve!: (values: number[]) => void;
    sample.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const second = renderer.render([segment]);
    expect([...primitives]).toEqual(old);
    resolve([]);
    await second;
    expect(primitives.size).toBe(3);
    expect(old.every(p => !primitives.has(p))).toBe(true);
  });

  it('远程高程不完整时不把已有轨道替换为假零高程', async () => {
    const { renderer, primitives, hasHeight } = setup();
    await renderer.render([segment]);
    const old = [...primitives];
    hasHeight.mockReturnValue(false);
    await expect(renderer.render([segment])).rejects.toThrow('保留已有轨道');
    expect([...primitives]).toEqual(old);
  });

  it('clear使进行中的旧请求失效，不会把已离开的线路重新画回来', async () => {
    const { renderer, primitives, sample } = setup();
    let resolve!: (values: number[]) => void;
    sample.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const rendering = renderer.render([segment]);
    renderer.clear();
    resolve([]);
    await rendering;
    expect(primitives.size).toBe(0);
  });
});
