import { Cartesian3, Matrix4, Primitive, type Viewer } from 'cesium';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialTrainState } from '../src/core/dynamics';
import { CabRenderer } from '../src/map/CabRenderer';
import { CAB_LAYOUT, cabDisplayGeometry } from '../src/map/cabGeometry';

vi.mock('cesium', async original => {
  const actual = await original<typeof import('cesium')>();
  return { ...actual,
    Material: class {
      uniforms: Record<string, unknown>; destroyed = false;
      constructor(options: any) { this.uniforms = options.fabric.uniforms; }
      isDestroyed() { return this.destroyed; }
      destroy() { this.destroyed = true; }
    },
    Primitive: class { show = false; modelMatrix = new actual.Matrix4(); constructor(readonly options: unknown) {} },
  };
});

function setup() {
  const context = { fillRect: vi.fn(), strokeRect: vi.fn(), fillText: vi.fn(), beginPath: vi.fn(),
    arc: vi.fn(), fill: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() };
  const canvases: Array<{ width: number; height: number; getContext: () => typeof context }> = [];
  vi.stubGlobal('document', { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => context }; canvases.push(canvas); return canvas;
  } });
  const primitives = new Set<Primitive>();
  const viewer = { scene: { primitives: {
    add: (p: Primitive) => { primitives.add(p); return p; }, remove: (p: Primitive) => primitives.delete(p),
  } } } as unknown as Viewer;
  return { renderer: new CabRenderer(viewer), context, canvases, primitives };
}

afterEach(() => vi.unstubAllGlobals());

describe('三维座舱', () => {
  it('眼前屏幕位于外壳前面，所有屏幕共享有效纹理坐标', () => {
    const faces = cabDisplayGeometry();
    expect(faces).toHaveLength(3);
    CAB_LAYOUT.screenCenters.forEach(center => {
      expect(center[1]).toBeLessThan(.57);
      expect(center[1]).toBeGreaterThan(.15);
      expect(center[2]).toBeLessThan(CAB_LAYOUT.eye[2]);
    });
    for (const face of faces) {
      const geometry = face.geometry as any;
      expect([...geometry.attributes.position.values].every(Number.isFinite)).toBe(true);
      expect([...geometry.attributes.st.values].every((value: number) => value >= 0 && value <= 1)).toBe(true);
    }
  });

  it('仪表读取实际运行状态，10Hz节流，行驶更新不追加图元或画布', () => {
    const { renderer, context, canvases, primitives } = setup();
    const train = initialTrainState(); train.velocity = 20; train.throttle = 37; train.brakeActual = 12;
    const frame = Matrix4.fromTranslation(new Cartesian3(1, 2, 3));
    renderer.update(frame, train, 62, 0);
    const written = context.fillText.mock.calls.map(args => args[0]);
    expect(written).toContain('072');
    expect(written).toContain('牵引  37%');
    expect(written).toContain('制动  12%');
    const count = context.fillText.mock.calls.length;
    renderer.update(frame, train, 62, 99);
    expect(context.fillText.mock.calls.length).toBe(count);
    for (let t = 100; t <= 2000; t += 10) renderer.update(frame, train, t / 1000, t);
    expect(primitives.size).toBe(3);
    expect(canvases).toHaveLength(2);
    expect([...primitives].every(p => p.show)).toBe(true);
  });

  it('退出驾驶室隐藏全部近处几何，销毁后释放图元与画布', () => {
    const { renderer, canvases, primitives } = setup();
    renderer.update(Matrix4.IDENTITY, initialTrainState(), 0, 0);
    renderer.hide();
    expect([...primitives].every(p => !p.show)).toBe(true);
    renderer.destroy();
    expect(primitives.size).toBe(0);
    expect(canvases.every(canvas => canvas.width === 1 && canvas.height === 1)).toBe(true);
  });
});
