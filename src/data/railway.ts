import { APP_CONFIG } from '../config';
import type { LonLat, ProvinceInfo, RailNode, RailProperties, RailSegment, SnapResult } from '../types';
import { bearing, distance, nearestOnSegment, pointAt } from '../utils/geo';
import { fetchJson } from '../utils/assets';

export interface RailBoundary {
  offset: number;
  nodeId: string;
}

export interface RailExit {
  key: string;
  segmentId: string;
  offset: number;
  /** Outgoing direction along the original coordinate array. */
  direction: 1 | -1;
}

export interface RailConnection extends RailExit {
  angle: number;
  gap: number;
  valid: boolean;
  reason: string;
  confidence: 'derived' | 'uncertain';
}

interface ProvinceIndex {
  type: 'province_index';
  provinces: ProvinceInfo[];
}

interface RawFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: [number, number][][] };
}

interface RawProvince {
  type: 'FeatureCollection';
  features: RawFeature[];
}

/** Injectable so the development inspector can resolve nested-page data paths in dev and build. */
export type JsonFetcher = <T>(path: string) => Promise<T>;

// Alias lookups keep existing V1 save IDs valid without rendering duplicate geometry.
class SegmentMap extends Map<string, RailSegment> {
  private aliases = new Map<string, string>();

  alias(id: string, canonicalId: string): void {
    this.aliases.set(id, canonicalId);
  }

  override get(id: string): RailSegment | undefined {
    return super.get(this.aliases.get(id) ?? id);
  }

  override has(id: string): boolean {
    return super.has(this.aliases.get(id) ?? id);
  }
}

const cellKey = (point: LonLat, size: number = APP_CONFIG.data.spatialCellSize) => `${Math.floor(point.lon / size)},${Math.floor(point.lat / size)}`;

export class RailNetwork {
  readonly segments = new SegmentMap();
  readonly nodes = new Map<string, RailNode>();
  readonly loadedProvinces = new Set<string>();
  private segmentGrid = new Map<string, Set<string>>();
  private nodeGrid = new Map<string, Set<string>>();
  private featureParts = new Map<string, string[]>();
  private nodeSequence = 0;
  private attachmentsDirty = true;
  private boundaries = new Map<string, RailBoundary[]>();
  private nodeExits = new Map<string, RailExit[]>();

  constructor(private readonly loadJson: JsonFetcher = fetchJson) {}

  async loadProvince(province: ProvinceInfo): Promise<{ segments: number; nodes: number }> {
    if (this.loadedProvinces.has(province.adcode)) return { segments: this.segments.size, nodes: this.nodes.size };
    const data = await this.loadJson<RawProvince>(province.file);
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error(`${province.province}线路数据格式不正确`);
    data.features.forEach((feature, featureIndex) => {
      const properties = this.readProperties(feature.properties, province.province);
      if (!properties || feature.geometry?.type !== 'MultiLineString') return;
      const dedupeKey = `${properties.osmId}:${properties.layer}`;
      let parts = this.featureParts.get(dedupeKey);
      if (!parts) {
        parts = [];
        this.featureParts.set(dedupeKey, parts);
      }
      feature.geometry.coordinates.forEach((rawPoints, partIndex) => {
        const points = rawPoints.filter((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])).map(([lon, lat]) => ({ lon, lat }));
        if (points.length < 2) return;
        const id = `${province.adcode}:${featureIndex}:${partIndex}`;
        const existingId = parts!.find((candidateId) => {
          const candidate = this.segments.get(candidateId)!;
          return candidate.points.length === points.length && candidate.points.every((point, index) => point.lon === points[index].lon && point.lat === points[index].lat);
        });
        if (existingId) {
          this.segments.alias(id, existingId);
          return;
        }
        const cumulative = [0];
        for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
        if (cumulative[cumulative.length - 1] < 0.1) return;
        const segment: RailSegment = { id, properties, points, cumulative, length: cumulative[cumulative.length - 1], startNode: '', endNode: '' };
        segment.startNode = this.connectNode(points[0], properties, id);
        segment.endNode = this.connectNode(points[points.length - 1], properties, id);
        this.segments.set(id, segment);
        this.indexSegment(segment);
        parts!.push(id);
      });
    });
    this.loadedProvinces.add(province.adcode);
    this.attachmentsDirty = true;
    return { segments: this.segments.size, nodes: this.nodes.size };
  }

  /** Next existing endpoint/shared-vertex boundary, without splitting or moving source geometry. */
  nextBoundary(segmentId: string, offset: number, coordinateDirection: number): RailBoundary | undefined {
    this.ensureAttachments();
    const segment = this.segments.get(segmentId);
    if (!segment) return;
    const attachments = this.boundaries.get(segment.id)!;
    if (coordinateDirection > 0) return attachments.find(boundary => boundary.offset > offset + 0.000001) ?? attachments[attachments.length - 1];
    for (let index = attachments.length - 1; index >= 0; index--) {
      if (attachments[index].offset < offset - 0.000001) return attachments[index];
    }
    return attachments[0];
  }

  /** Read-only snapshot for offline diagnostics; boundaries remain owned by the network. */
  boundariesOf(segmentId: string): RailBoundary[] {
    this.ensureAttachments();
    const segment = this.segments.get(segmentId);
    return segment ? (this.boundaries.get(segment.id) ?? []).map(boundary => ({ ...boundary })) : [];
  }

  /** Oriented exits at a shared vertex, excluding only the direction just travelled from. */
  exitsAt(segmentId: string, boundary: RailBoundary, coordinateDirection: number): RailExit[] {
    this.ensureAttachments();
    const segment = this.segments.get(segmentId);
    if (!segment) return [];
    return (this.nodeExits.get(boundary.nodeId) ?? []).filter(exit => !(exit.segmentId === segment.id &&
      Math.abs(exit.offset - boundary.offset) < 0.000001 && exit.direction === -Math.sign(coordinateDirection)));
  }

  /** Derived geometry only: positive angle turns right, negative turns left. */
  connectionsAt(segmentId: string, boundary: RailBoundary, coordinateDirection: number): RailConnection[] {
    const incoming = this.segments.get(segmentId);
    if (!incoming) return [];
    const at = pointAt(incoming, boundary.offset);
    const before = pointAt(incoming, boundary.offset - Math.sign(coordinateDirection) * 10);
    const incomingLength = distance(before, at);
    return this.exitsAt(segmentId, boundary, coordinateDirection).map(exit => {
      const next = this.segments.get(exit.segmentId)!;
      const start = pointAt(next, exit.offset);
      const after = pointAt(next, exit.offset + exit.direction * 10);
      const gap = distance(at, start);
      const outgoingLength = distance(start, after);
      const angle = ((bearing(start, after) - bearing(before, at) + 540) % 360) - 180;
      const interior = (boundary.offset > 0.000001 && boundary.offset < incoming.length - 0.000001) ||
        (exit.offset > 0.000001 && exit.offset < next.length - 0.000001);
      // A nearby endpoint is not proof of an attachment to an existing interior vertex.
      const interiorGapUncertain = incoming.id !== exit.segmentId && interior && gap > APP_CONFIG.simulation.junctionInteriorMaxGap;
      const a = incoming.properties, b = next.properties;
      const attributeConflict = a.layer !== b.layer || a.bridge !== b.bridge || a.tunnel !== b.tunnel;
      const bridgeTunnelChange = a.bridge !== b.bridge || a.tunnel !== b.tunnel;
      // Exact OSM shared vertices are evidence of a common node. Bridge/tunnel/layer tags describe
      // the way, not a second connection test, so a ground-to-bridge or layer change at the same
      // coordinate must not cut the main line. Keep the looser tolerance rules for non-exact gaps.
      const exactSharedVertex = gap < APP_CONFIG.simulation.junctionExactMaxGap;
      const exactAttributeTransition = exactSharedVertex && Math.abs(angle) <= APP_CONFIG.simulation.junctionTransitionMaxTurnDegrees;
      const plausibleTransition = !exactSharedVertex && gap <= APP_CONFIG.simulation.junctionTransitionMaxGap &&
        Math.abs(angle) <= APP_CONFIG.simulation.junctionTransitionMaxTurnDegrees &&
        !(a.bridge && b.tunnel) && !(a.tunnel && b.bridge) && Math.abs(a.layer - b.layer) <= 1 &&
        bridgeTunnelChange;
      let reason = exactSharedVertex ? '原始坐标重合，方向连续性推定' : '距离容差内的派生连接';
      if (incomingLength < 0.1 || outgoingLength < 0.1) reason = '切线长度不足';
      else if (gap > APP_CONFIG.simulation.junctionTransitionMaxGap) reason = '端点存在间隙，无法确认物理连接';
      else if (interiorGapUncertain) reason = '内部顶点与外部端点未重合，连接未确认';
      else if (Math.abs(angle) >= APP_CONFIG.simulation.junctionMaxTurnDegrees) reason = '接近掉头，须停车换向';
      else if (attributeConflict && exactAttributeTransition) {
        reason = bridgeTunnelChange ? '共享端点的桥隧过渡，按几何连续性推定' : '共享端点的层级变化，按几何连续性推定';
      } else if (attributeConflict && !plausibleTransition) reason = '层级或桥隧属性冲突，连接未确认';
      else if (attributeConflict) reason = '重合且走向连续的桥隧过渡，仍需核验';
      const valid = incomingLength >= 0.1 && outgoingLength >= 0.1 && gap <= APP_CONFIG.simulation.junctionTransitionMaxGap && !interiorGapUncertain &&
        Math.abs(angle) < APP_CONFIG.simulation.junctionMaxTurnDegrees && (!attributeConflict || exactAttributeTransition || plausibleTransition);
      return { ...exit, angle, gap, valid, reason, confidence: attributeConflict || gap >= APP_CONFIG.simulation.junctionExactMaxGap ? 'uncertain' as const : 'derived' as const };
    }).sort((a, b) => a.angle - b.angle || a.key.localeCompare(b.key));
  }

  drivableExits(segmentId: string, boundary: RailBoundary, direction: number): RailConnection[] {
    return this.connectionsAt(segmentId, boundary, direction).filter(connection => connection.valid);
  }

  previewPath(first: RailConnection): { points: LonLat[]; length: number; stopReason: string; names: string[]; uncertain: boolean } {
    const points: LonLat[] = [];
    const names = new Set<string>();
    const visited = new Set<string>();
    let exit: RailExit = first, length = 0, uncertain = first.confidence === 'uncertain';
    let stopReason = '节点数量上限';
    for (let i = 0; i < APP_CONFIG.simulation.junctionPathMaxBoundaries; i++) {
      if (visited.has(exit.key)) { stopReason = '检测到环路'; break; }
      visited.add(exit.key);
      const segment = this.segments.get(exit.segmentId);
      if (!segment) { stopReason = '区段数据缺失'; break; }
      if (segment.properties.name !== '未命名铁路') names.add(segment.properties.name);
      const boundary = this.nextBoundary(segment.id, exit.offset, exit.direction);
      if (!boundary) { stopReason = '线路数据边界'; break; }
      const available = Math.abs(boundary.offset - exit.offset);
      const step = Math.min(available, APP_CONFIG.simulation.junctionPathPreviewMeters - length);
      const end = exit.offset + exit.direction * step;
      if (!points.length) points.push(pointAt(segment, exit.offset));
      const vertices = segment.cumulative.map((offset, index) => ({ offset, point: segment.points[index] }))
        .filter(item => exit.direction > 0 ? item.offset > exit.offset && item.offset < end : item.offset < exit.offset && item.offset > end);
      if (exit.direction < 0) vertices.reverse();
      points.push(...vertices.map(item => item.point), pointAt(segment, end));
      length += step;
      if (step < available || length >= APP_CONFIG.simulation.junctionPathPreviewMeters) { stopReason = '预览距离上限'; break; }
      const exits = this.drivableExits(segment.id, boundary, exit.direction);
      if (exits.length !== 1) { stopReason = exits.length ? '下一处分岔' : '线路中断或数据边界'; break; }
      uncertain ||= exits[0].confidence === 'uncertain';
      exit = exits[0];
    }
    return { points, length, stopReason, names: [...names], uncertain };
  }

  private ensureAttachments(): void {
    if (!this.attachmentsDirty) return;
    this.attachmentsDirty = false;
    this.boundaries.clear();
    this.nodeExits.clear();
    // A tight grid avoids scanning every station-yard endpoint for every original vertex.
    const size = 0.00005;
    const grid = new Map<string, RailNode[]>();
    for (const node of this.nodes.values()) {
      const key = cellKey(node, size);
      const bucket = grid.get(key);
      if (bucket) bucket.push(node); else grid.set(key, [node]);
    }
    for (const segment of this.segments.values()) {
      const attachments: RailBoundary[] = [];
      segment.points.forEach((point, index) => {
        let nodeId: string | undefined;
        if (index === 0) nodeId = segment.startNode;
        else if (index === segment.points.length - 1) nodeId = segment.endNode;
        else {
          const cx = Math.floor(point.lon / size), cy = Math.floor(point.lat / size);
          const rangeX = Math.ceil(APP_CONFIG.data.endpointTolerance / (110_000 * Math.cos(Math.min(89, Math.abs(point.lat)) * Math.PI / 180) * size));
          const rangeY = Math.ceil(APP_CONFIG.data.endpointTolerance / (110_000 * size));
          let nearest: number = APP_CONFIG.data.endpointTolerance;
          for (let x = cx - rangeX; x <= cx + rangeX; x++) {
            for (let y = cy - rangeY; y <= cy + rangeY; y++) {
              for (const node of grid.get(`${x},${y}`) ?? []) {
                const d = distance(point, node);
                if (d <= nearest) { nearest = d; nodeId = node.id; }
              }
            }
          }
        }
        if (!nodeId) return;
        const offset = segment.cumulative[index];
        if (attachments.some(boundary => Math.abs(boundary.offset - offset) < 0.000001)) return;
        attachments.push({ offset, nodeId });
        let exits = this.nodeExits.get(nodeId);
        if (!exits) { exits = []; this.nodeExits.set(nodeId, exits); }
        const addExit = (direction: 1 | -1) => exits!.push({
          key: `${segment.id}@${direction}@${offset.toFixed(6)}`, segmentId: segment.id, offset, direction,
        });
        if (offset > 0.000001) addExit(-1);
        if (offset < segment.length - 0.000001) addExit(1);
      });
      this.boundaries.set(segment.id, attachments);
    }
  }

  nearest(point: LonLat, maxDistance: number): SnapResult | null {
    const candidates = this.candidatesNear(point, maxDistance);
    let best: SnapResult | null = null;
    for (const id of candidates) {
      const segment = this.segments.get(id);
      if (!segment) continue;
      const snapped = nearestOnSegment(segment, point);
      if (snapped && snapped.distance <= maxDistance && (!best || snapped.distance < best.distance)) best = snapped;
    }
    return best;
  }

  connections(segmentId: string, atEnd: boolean): RailSegment[] {
    const segment = this.segments.get(segmentId);
    if (!segment) return [];
    const node = this.nodes.get(atEnd ? segment.endNode : segment.startNode);
    return node ? node.segmentIds.filter((id) => id !== segment.id).map((id) => this.segments.get(id)!).filter(Boolean) : [];
  }

  nodeFor(segmentId: string, atEnd: boolean): RailNode | undefined {
    const segment = this.segments.get(segmentId);
    return segment ? this.nodes.get(atEnd ? segment.endNode : segment.startNode) : undefined;
  }

  segmentsNear(point: LonLat, radius: number, limit: number = APP_CONFIG.data.maxRenderSegments, prioritySegmentId?: string): RailSegment[] {
    const priority = prioritySegmentId ? this.segments.get(prioritySegmentId)?.id : undefined;
    return [...this.candidatesNear(point, radius)]
      .map((id) => {
        const segment = this.segments.get(id)!;
        return { segment, distance: nearestOnSegment(segment, point)?.distance ?? Infinity };
      })
      .filter((entry) => entry.distance <= radius)
      .sort((a, b) => Number(b.segment.id === priority) - Number(a.segment.id === priority) || a.distance - b.distance)
      .slice(0, limit)
      .map((entry) => entry.segment);
  }

  private candidatesNear(point: LonLat, radius: number): Set<string> {
    const size = APP_CONFIG.data.spatialCellSize;
    // Longitude degrees shrink northwards; use the outer latitude for a conservative bound.
    const latitudeSpan = radius / 110_000;
    const outerLatitude = Math.min(89, Math.abs(point.lat) + latitudeSpan);
    const longitudeSpan = radius / (110_000 * Math.cos(outerLatitude * Math.PI / 180));
    const candidates = new Set<string>();
    for (let x = Math.floor((point.lon - longitudeSpan) / size); x <= Math.floor((point.lon + longitudeSpan) / size); x++) {
      for (let y = Math.floor((point.lat - latitudeSpan) / size); y <= Math.floor((point.lat + latitudeSpan) / size); y++) {
        this.segmentGrid.get(`${x},${y}`)?.forEach((id) => candidates.add(id));
      }
    }
    return candidates;
  }

  private readProperties(raw: Record<string, unknown>, fallbackProvince: string): RailProperties | null {
    const code = typeof raw.code === 'number' ? raw.code : undefined;
    const fclass = typeof raw.fclass === 'string' ? raw.fclass : undefined;
    if (code !== 6101 && !(code === undefined && fclass === 'rail')) return null;
    return {
      province: typeof raw.province === 'string' ? raw.province : fallbackProvince,
      osmId: String(raw.osm_id ?? 'unknown'),
      code,
      fclass,
      name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : '未命名铁路',
      layer: typeof raw.layer === 'number' ? raw.layer : 0,
      bridge: raw.bridge === 'T',
      tunnel: raw.tunnel === 'T',
    };
  }

  private connectNode(point: LonLat, properties: RailProperties, segmentId: string): string {
    const cx = Math.floor(point.lon / APP_CONFIG.data.spatialCellSize);
    const cy = Math.floor(point.lat / APP_CONFIG.data.spatialCellSize);
    let found: RailNode | undefined;
    let nearestDistance: number = APP_CONFIG.data.endpointTolerance;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        this.nodeGrid.get(`${x},${y}`)?.forEach((id) => {
          const node = this.nodes.get(id)!;
          const d = distance(point, node);
          // Connectivity follows endpoint position only; bridge/tunnel/layer remain metadata.
          if (d <= nearestDistance) {
            found = node;
            nearestDistance = d;
          }
        });
      }
    }
    if (!found) {
      const id = `node-${this.nodeSequence++}`;
      found = { ...point, id, layer: properties.layer, bridge: properties.bridge, tunnel: properties.tunnel, segmentIds: [] };
      this.nodes.set(id, found);
      const key = cellKey(point);
      if (!this.nodeGrid.has(key)) this.nodeGrid.set(key, new Set());
      this.nodeGrid.get(key)!.add(id);
    }
    if (!found.segmentIds.includes(segmentId)) found.segmentIds.push(segmentId);
    return found.id;
  }

  private indexSegment(segment: RailSegment): void {
    const size = APP_CONFIG.data.spatialCellSize;
    const cells = new Set<string>();
    for (let i = 1; i < segment.points.length; i++) {
      const a = segment.points[i - 1];
      const b = segment.points[i];
      // Cover every cell touched by an edge, including long edges without internal vertices.
      for (let x = Math.floor(Math.min(a.lon, b.lon) / size); x <= Math.floor(Math.max(a.lon, b.lon) / size); x++) {
        for (let y = Math.floor(Math.min(a.lat, b.lat) / size); y <= Math.floor(Math.max(a.lat, b.lat) / size); y++) cells.add(`${x},${y}`);
      }
    }
    cells.forEach((key) => {
      if (!this.segmentGrid.has(key)) this.segmentGrid.set(key, new Set());
      this.segmentGrid.get(key)!.add(segment.id);
    });
  }

}

export class RailwayRepository {
  readonly network: RailNetwork;
  provinces: ProvinceInfo[] = [];
  private loading = new Map<string, Promise<unknown>>();

  constructor(private readonly loadJson: JsonFetcher = fetchJson) {
    this.network = new RailNetwork(loadJson);
  }

  async loadIndex(): Promise<void> {
    if (this.provinces.length) return;
    const data = await this.loadJson<ProvinceIndex>('provinces_index.json');
    if (data.type !== 'province_index' || !Array.isArray(data.provinces)) throw new Error('分省线路索引格式不正确');
    this.provinces = data.provinces;
  }

  byProvince(name: string): ProvinceInfo | undefined {
    return this.provinces.find((province) => province.province === name);
  }

  async load(name: string): Promise<void> {
    const province = this.byProvince(name);
    if (!province) throw new Error(`没有 ${name} 的铁路数据`);
    if (this.network.loadedProvinces.has(province.adcode)) return;
    if (!this.loading.has(province.adcode)) {
      this.loading.set(province.adcode, this.network.loadProvince(province).finally(() => this.loading.delete(province.adcode)));
    }
    await this.loading.get(province.adcode);
  }
}
