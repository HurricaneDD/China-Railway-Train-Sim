import {
  BoundingSphere, Cartesian3, Color, ColorGeometryInstanceAttribute, ComponentDatatype,
  Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, Matrix4, PrimitiveType, Transforms,
} from 'cesium';
import { APP_CONFIG } from '../config';
import type { ElevationService } from '../core/elevation';
import type { LonLat, RailSegment } from '../types';
import { nearestOnSegment, offsetPoint, pointAt } from '../utils/geo';
import { hasDemoCatenary, type SceneryChunk } from './sceneryPlan';

type Vector = [number, number, number];
const palette = { ballast: '#606258', shoulder: '#77766a', sleeper: '#99968b', steel: '#aab4b0',
  darkSteel: '#525b5c', concrete: '#b0b2a8', white: '#e6e5d7', yellow: '#d4b45b' };
type Material = keyof typeof palette;

/** One indexed mesh per material per chunk; no per-sleeper Entity or world-sized float buffer. */
class Mesh {
  positions: number[] = [];
  normals: number[] = [];
  indices: number[] = [];
  quad(a: Vector, b: Vector, c: Vector, d: Vector): void {
    const index = this.positions.length / 3;
    this.positions.push(...a, ...b, ...c, ...d);
    const ab = b.map((v, i) => v - a[i]), ac = c.map((v, i) => v - a[i]);
    const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const length = Math.hypot(...normal) || 1;
    for (let i = 0; i < 4; i++) this.normals.push(...normal.map(v => v / length));
    this.indices.push(index, index + 1, index + 2, index, index + 2, index + 3);
  }
  box(center: Vector, heading: number, length: number, width: number, height: number): void {
    const angle = heading * Math.PI / 180;
    const along = [Math.sin(angle), Math.cos(angle)];
    const right = [Math.cos(angle), -Math.sin(angle)];
    const v = (x: number, y: number, z: number): Vector => [
      center[0] + along[0] * x + right[0] * y,
      center[1] + along[1] * x + right[1] * y, center[2] + z,
    ];
    const l = length / 2, w = width / 2;
    const a = v(-l, -w, 0), b = v(l, -w, 0), c = v(l, w, 0), d = v(-l, w, 0);
    const e = v(-l, -w, height), f = v(l, -w, height), g = v(l, w, height), h = v(-l, w, height);
    this.quad(e, h, g, f); this.quad(a, b, c, d);
    this.quad(a, e, f, b); this.quad(b, f, g, c); this.quad(c, g, h, d); this.quad(d, h, e, a);
  }
}

export function buildSceneryGeometry(chunk: SceneryChunk, elevation: ElevationService, nearby: RailSegment[]): GeometryInstance[] {
  const { segment, start, end } = chunk;
  const origin = pointAt(segment, start);
  const transform = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(origin.lon, origin.lat));
  const inverse = Matrix4.inverseTransformation(transform, new Matrix4());
  const meshes = new Map<Material, Mesh>();
  const mesh = (material: Material) => {
    if (!meshes.has(material)) meshes.set(material, new Mesh());
    return meshes.get(material)!;
  };
  const at = (offset: number, lateral = 0, up = 0): Vector => {
    const p = pointAt(segment, offset);
    const shifted = offsetPoint(p, p.heading, lateral);
    const h = elevation.railHeight(segment, offset);
    if (h === undefined) throw new Error('轨旁场景高程不完整');
    const local = Matrix4.multiplyByPoint(inverse,
      Cartesian3.fromDegrees(shifted.lon, shifted.lat, h + APP_CONFIG.track.heightOffset + up), new Cartesian3());
    return [local.x, local.y, local.z];
  };
  const box = (material: Material, offset: number, lateral: number, up: number, length: number, width: number, height: number) => {
    mesh(material).box(at(offset, lateral, up), pointAt(segment, offset).heading, length, width, height);
  };
  const offsets = new Set([start, end]);
  for (let s = Math.ceil(start / APP_CONFIG.scenery.sampleSpacing) * APP_CONFIG.scenery.sampleSpacing; s < end; s += APP_CONFIG.scenery.sampleSpacing) offsets.add(s);
  segment.cumulative.forEach(s => { if (s > start && s < end) offsets.add(s); });
  const samples = [...offsets].sort((a, b) => a - b);
  const strip = (material: Material, left: number, right: number, heightLeft: number, heightRight = heightLeft) => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      mesh(material).quad(at(a, left, heightLeft), at(b, left, heightLeft), at(b, right, heightRight), at(a, right, heightRight));
    }
  };
  strip('ballast', -1.75, 1.75, -0.34);
  strip('shoulder', -2.5, -1.75, -0.80, -0.34);
  strip('shoulder', 1.75, 2.5, -0.34, -0.80);
  for (const side of [-1, 1]) {
    const center = side * APP_CONFIG.track.gauge / 2;
    strip('steel', center - 0.037, center + 0.037, 0.015);
    strip('darkSteel', center - 0.025, center - 0.025, -0.15, 0.015);
    strip('darkSteel', center + 0.025, center + 0.025, 0.015, -0.15);
  }
  // Half-open chunk ownership keeps repeated objects stable when approaching, reversing or reloading.
  const repeat = (spacing: number, callback: (s: number) => void) => {
    for (let s = Math.ceil((start - 1e-7) / spacing) * spacing; s < end - 1e-7; s += spacing) callback(Math.max(start, s));
  };
  repeat(APP_CONFIG.scenery.sleeperSpacing, s => box('sleeper', s, 0, -0.29, 0.25, 2.6, 0.13));
  // Do not put roadside equipment through another mapped track in dense stations.
  const clear = (s: number, lateral: number) => {
    const p = pointAt(segment, s);
    const position = offsetPoint(p, p.heading, lateral);
    return !nearby.some(other => other.id !== segment.id && (nearestOnSegment(other, position)?.distance ?? Infinity) < 3);
  };
  if (!segment.properties?.tunnel) {
    for (const side of [-1, 1]) {
      repeat(25, s => {
        if (!clear(s, side * 3.4)) return;
        box('concrete', s, side * 3.4, -0.75, 0.16, 0.16, 1.45);
        box('white', s, side * 3.4, 0.45, 0.18, 0.18, 0.2);
      });
      // Short fence panels follow curvature and leave openings where another track approaches.
      repeat(5, s => {
        const b = Math.min(end, s + 5);
        if (b - s < 0.1 || !clear(s, side * 3.4) || !clear(b, side * 3.4)) return;
        for (const up of [-0.15, 0.5]) {
          mesh('darkSteel').quad(at(s, side * 3.4, up), at(b, side * 3.4, up),
            at(b, side * 3.4, up + 0.05), at(s, side * 3.4, up + 0.05));
        }
      });
    }
    repeat(250, s => {
      if (!clear(s, 4.2)) return;
      box('concrete', s, 4.2, -0.8, 1.25, 1.15, 0.2);
      box('darkSteel', s, 4.2, -0.6, 0.8, 0.65, 1.15);
      box('yellow', s, 3.86, -0.2, 0.25, 0.02, 0.18);
    });
  }
  // A procedural demonstration, not an inferred national electrification inventory.
  repeat(50, s => {
    if (!hasDemoCatenary(segment, pointAt(segment, s))) return;
    const side = clear(s, 3.3) ? 1 : clear(s, -3.3) ? -1 : 0;
    if (!side) return;
    box('concrete', s, side * 3.3, -0.8, 0.32, 0.32, 8);
    box('darkSteel', s, side * 1.65, 6.2, 0.12, 3.6, 0.12);
    box('yellow', s, side * 0.3, 5.6, 0.15, 0.15, 0.6);
  });
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    if (!hasDemoCatenary(segment, pointAt(segment, (a + b) / 2))) continue;
    // World-width wire ribbons remain independent of screen resolution.
    for (const up of [5.6, 6.4]) {
      mesh('darkSteel').quad(at(a, -0.018, up), at(b, -0.018, up), at(b, 0.018, up), at(a, 0.018, up));
    }
  }
  return [...meshes.entries()].map(([material, data]) => {
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({
      componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(data.positions),
    });
    attributes.normal = new GeometryAttribute({
      componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(data.normals),
    });
    return new GeometryInstance({
      id: `scenery:${chunk.key}:${material}`,
      modelMatrix: transform,
      geometry: new Geometry({ attributes,
        indices: data.positions.length / 3 > 65535 ? new Uint32Array(data.indices) : new Uint16Array(data.indices),
        primitiveType: PrimitiveType.TRIANGLES, boundingSphere: BoundingSphere.fromVertices(data.positions) }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(palette[material])) },
    });
  });
}
