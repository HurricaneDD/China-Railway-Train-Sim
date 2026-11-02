import { APP_CONFIG } from '../config';
import type { LonLat, ProvinceInfo, RailNode, RailProperties, RailSegment, SnapResult } from '../types';
import { distance, nearestOnSegment } from '../utils/geo';
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

  async loadProvince(province: ProvinceInfo): Promise<{ segments: number; nodes: number }> {
    if (this.loadedProvinces.has(province.adcode)) return { segments: this.segments.size, nodes: this.nodes.size };
    const data = await fetchJson<RawProvince>(province.file);
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

  /** Oriented exits at a shared vertex, excluding only the direction just travelled from. */
  exitsAt(segmentId: string, boundary: RailBoundary, coordinateDirection: number): RailExit[] {
    this.ensureAttachments();
    const segment = this.segments.get(segmentId);
    if (!segment) return [];
    return (this.nodeExits.get(boundary.nodeId) ?? []).filter(exit => !(exit.segmentId === segment.id &&
      Math.abs(exit.offset - boundary.offset) < 0.000001 && exit.direction === -Math.sign(coordinateDirection)));
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
  readonly network = new RailNetwork();
  provinces: ProvinceInfo[] = [];
  private loading = new Map<string, Promise<unknown>>();

  async loadIndex(): Promise<void> {
    if (this.provinces.length) return;
    const data = await fetchJson<ProvinceIndex>('provinces_index.json');
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
