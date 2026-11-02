import {
  BoundingSphere, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype,
  Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, PerInstanceColorAppearance, PolylineColorAppearance,
  PolylineGeometry, Primitive, PrimitiveType, type Viewer,
} from 'cesium';
import { APP_CONFIG } from '../config';
import type { ElevationService } from '../core/elevation';
import type { LonLat, RailSegment } from '../types';
import { distance, nearestOnSegment, offsetPoint, pointAt } from '../utils/geo';

export class RailRenderer {
  private primitives: Primitive[] = [];
  private staged = new Set<Primitive>();
  private generation = 0;

  constructor(private viewer: Viewer, private elevation: ElevationService) {}

  clear(): void {
    this.generation++;
    [...this.primitives, ...this.staged].forEach(primitive => this.viewer.scene.primitives.remove(primitive));
    this.primitives = [];
    this.staged.clear();
  }

  async render(segments: RailSegment[], focus?: LonLat): Promise<void> {
    const generation = ++this.generation;
    if (!segments.length) { this.clear(); return; }
    const unique = new Map<string, LonLat>();
    segments.forEach(segment => segment.points.forEach(point => unique.set(`${point.lon.toFixed(5)},${point.lat.toFixed(5)}`, point)));
    await this.elevation.sample([...unique.values()]);
    if (generation !== this.generation || this.viewer.isDestroyed()) return;
    const available = segments.filter(segment => segment.points.every(point => this.elevation.hasHeight(point)));
    if (available.length !== segments.length && this.primitives.length > 0) {
      throw new Error('部分轨道高程暂不可用，保留已有轨道；请重试地图服务');
    }
    if (!available.length) throw new Error('轨道高程尚未加载，请重试地图服务');
    const rails: GeometryInstance[] = [];
    const ballast: GeometryInstance[] = [];
    const sleeperCandidates: Array<{ point: LonLat & { heading: number }; height: number; distance: number }> = [];

    for (const segment of available) {
      const centerHeights = segment.points.map(point => this.elevation.height(point) + APP_CONFIG.track.heightOffset);
      const headings = segment.points.map((_, index) => pointAt(segment, segment.cumulative[index] + (index < segment.points.length - 1 ? 0.01 : 0)).heading);
      const sides = [-1, 1].map(side => segment.points.map((point, index) => {
        const shifted = offsetPoint(point, headings[index], side * APP_CONFIG.track.gauge / 2);
        return Cartesian3.fromDegrees(shifted.lon, shifted.lat, centerHeights[index]);
      }));
      sides.forEach(positions => rails.push(this.polyline(positions, 2.2, Color.fromCssColorString('#cdd3ce'))));
      ballast.push(this.ballastRibbon(segment, headings, centerHeights));
      // Dense sleepers only near the cab. Select nearest sleepers globally rather than exhausting
      // the budget on the first yard track in the source file.
      const nearest = focus ? nearestOnSegment(segment, focus) : null;
      if (nearest && nearest.distance > 1400) continue;
      const near = !focus || (nearest && nearest.distance < 650);
      const spacing = near ? 0.85 : APP_CONFIG.track.sleeperSpacing;
      const startOffset = nearest ? Math.max(0, nearest.offset - 1600) : 0;
      const endOffset = nearest ? Math.min(segment.length, nearest.offset + 1600) : segment.length;
      for (let offset = Math.ceil(startOffset / spacing) * spacing; offset < endOffset; offset += spacing) {
        const center = pointAt(segment, offset);
        const d = focus ? distance(center, focus) : offset;
        if (focus && d > 1400) continue;
        const upper = segment.cumulative.findIndex(value => value >= offset);
        const index = Math.min(segment.points.length - 1, Math.max(1, upper));
        const span = segment.cumulative[index] - segment.cumulative[index - 1];
        const fraction = span > 0 ? (offset - segment.cumulative[index - 1]) / span : 0;
        const height = centerHeights[index - 1] + (centerHeights[index] - centerHeights[index - 1]) * fraction;
        sleeperCandidates.push({ point: center, height, distance: d });
      }
    }
    const sleepers = sleeperCandidates.sort((a, b) => a.distance - b.distance).slice(0, 1800).map(({ point, height }) => {
      const left = offsetPoint(point, point.heading, -APP_CONFIG.track.sleeperLength / 2);
      const right = offsetPoint(point, point.heading, APP_CONFIG.track.sleeperLength / 2);
      return this.polyline([Cartesian3.fromDegrees(left.lon, left.lat, height), Cartesian3.fromDegrees(right.lon, right.lat, height)], 3.2, Color.fromCssColorString('#615c50'));
    });
    if (generation !== this.generation) return;
    const next = [
      this.createPrimitive(ballast, true),
      this.createPrimitive(rails),
      this.createPrimitive(sleepers),
    ].filter((primitive): primitive is Primitive => !!primitive);
    next.forEach(primitive => { this.viewer.scene.primitives.add(primitive); this.staged.add(primitive); });
    const ready = await this.waitUntilReady(next, generation);
    if (!ready || generation !== this.generation || this.viewer.isDestroyed()) {
      if (!this.viewer.isDestroyed()) next.forEach(primitive => this.viewer.scene.primitives.remove(primitive));
      next.forEach(primitive => this.staged.delete(primitive));
      if (!ready && generation === this.generation) throw new Error('轨道绘制超时，保留已有轨道');
      return;
    }
    this.primitives.forEach(primitive => this.viewer.scene.primitives.remove(primitive));
    this.primitives = next;
    next.forEach(primitive => this.staged.delete(primitive));
  }

  private waitUntilReady(primitives: Primitive[], generation: number): Promise<boolean> {
    return new Promise(resolve => {
      let removeListener: (() => void) | undefined;
      const finish = (ready: boolean) => { clearTimeout(timer); removeListener?.(); resolve(ready); };
      const timer = setTimeout(() => finish(false), 15_000);
      removeListener = this.viewer.scene.postRender.addEventListener(() => {
        if (generation !== this.generation || primitives.every(primitive => primitive.ready)) finish(true);
      });
      this.viewer.scene.requestRender();
    });
  }

  private ballastRibbon(segment: RailSegment, headings: number[], heights: number[]): GeometryInstance {
    const positions: number[] = [];
    segment.points.forEach((point, index) => {
      for (const side of [-1, 1]) {
        const p = offsetPoint(point, headings[index], side * 2.1);
        const cartesian = Cartesian3.fromDegrees(p.lon, p.lat, heights[index] - 0.08);
        positions.push(cartesian.x, cartesian.y, cartesian.z);
      }
    });
    const indices: number[] = [];
    for (let i = 0; i < segment.points.length - 1; i++) {
      const base = i * 2;
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(positions) });
    return new GeometryInstance({
      geometry: new Geometry({
        attributes,
        indices: positions.length / 3 > 65535 ? new Uint32Array(indices) : new Uint16Array(indices),
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(positions),
      }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString('#55584e')) },
    });
  }

  private polyline(positions: Cartesian3[], width: number, color: Color): GeometryInstance {
    return new GeometryInstance({
      geometry: new PolylineGeometry({ positions, width, vertexFormat: PolylineColorAppearance.VERTEX_FORMAT }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
    });
  }

  private createPrimitive(instances: GeometryInstance[], surface = false): Primitive | undefined {
    if (!instances.length) return undefined;
    return new Primitive({
      geometryInstances: instances,
      appearance: surface
        ? new PerInstanceColorAppearance({ flat: true, translucent: false, closed: false })
        : new PolylineColorAppearance({ translucent: false }),
      asynchronous: !surface,
      allowPicking: false,
    });
  }
}
