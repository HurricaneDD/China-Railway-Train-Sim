import { APP_CONFIG } from '../config';
import type { LonLat, ProvinceInfo, RailNode, RailProperties, RailSegment, SnapResult } from '../types';
import { distance, nearestOnSegment } from '../utils/geo';
import { fetchJson } from '../utils/assets';

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

const cellKey = (point: LonLat, size = APP_CONFIG.data.spatialCellSize) => `${Math.floor(point.lon / size)},${Math.floor(point.lat / size)}`;

export class RailNetwork {
  readonly segments = new Map<string, RailSegment>();
  readonly nodes = new Map<string, RailNode>();
  readonly loadedProvinces = new Set<string>();
  private segmentGrid = new Map<string, Set<string>>();
  private nodeGrid = new Map<string, Set<string>>();
  private featureKeys = new Set<string>();
  private nodeSequence = 0;

  async loadProvince(province: ProvinceInfo): Promise<{ segments: number; nodes: number }> {
    if (this.loadedProvinces.has(province.adcode)) return { segments: this.segments.size, nodes: this.nodes.size };
    const data = await fetchJson<RawProvince>(province.file);
    if (data.type !== 'FeatureCollection' || !Array.isArray(data.features)) throw new Error(`${province.province}线路数据格式不正确`);
    let added = 0;
    data.features.forEach((feature, featureIndex) => {
      const properties = this.readProperties(feature.properties, province.province);
      if (!properties || feature.geometry?.type !== 'MultiLineString') return;
      const dedupeKey = `${properties.osmId}:${properties.layer}`;
      if (this.featureKeys.has(dedupeKey)) return;
      this.featureKeys.add(dedupeKey);
      feature.geometry.coordinates.forEach((rawPoints, partIndex) => {
        const points = rawPoints.filter((point) => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])).map(([lon, lat]) => ({ lon, lat }));
        if (points.length < 2) return;
        const cumulative = [0];
        for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
        if (cumulative[cumulative.length - 1] < 0.1) return;
        const id = `${province.adcode}:${featureIndex}:${partIndex}`;
        const segment: RailSegment = { id, properties, points, cumulative, length: cumulative[cumulative.length - 1], startNode: '', endNode: '' };
        segment.startNode = this.connectNode(points[0], properties, id);
        segment.endNode = this.connectNode(points[points.length - 1], properties, id);
        this.segments.set(id, segment);
        this.indexSegment(segment);
        added++;
      });
    });
    this.loadedProvinces.add(province.adcode);
    return { segments: this.segments.size, nodes: this.nodes.size };
  }

  nearest(point: LonLat, maxDistance: number): SnapResult | null {
    const cells = Math.ceil(maxDistance / 111_000 / APP_CONFIG.data.spatialCellSize) + 1;
    const centerLon = Math.floor(point.lon / APP_CONFIG.data.spatialCellSize);
    const centerLat = Math.floor(point.lat / APP_CONFIG.data.spatialCellSize);
    const candidates = new Set<string>();
    for (let x = centerLon - cells; x <= centerLon + cells; x++) {
      for (let y = centerLat - cells; y <= centerLat + cells; y++) {
        this.segmentGrid.get(`${x},${y}`)?.forEach((id) => candidates.add(id));
      }
    }
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
    return node ? node.segmentIds.filter((id) => id !== segmentId).map((id) => this.segments.get(id)!).filter(Boolean) : [];
  }

  nodeFor(segmentId: string, atEnd: boolean): RailNode | undefined {
    const segment = this.segments.get(segmentId);
    return segment ? this.nodes.get(atEnd ? segment.endNode : segment.startNode) : undefined;
  }

  segmentsNear(point: LonLat, radius: number, limit = APP_CONFIG.data.maxRenderSegments): RailSegment[] {
    const candidates = new Set<string>();
    const range = Math.ceil(radius / 90_000 / APP_CONFIG.data.spatialCellSize);
    const cx = Math.floor(point.lon / APP_CONFIG.data.spatialCellSize);
    const cy = Math.floor(point.lat / APP_CONFIG.data.spatialCellSize);
    for (let x = cx - range; x <= cx + range; x++) {
      for (let y = cy - range; y <= cy + range; y++) this.segmentGrid.get(`${x},${y}`)?.forEach((id) => candidates.add(id));
    }
    return [...candidates].map((id) => this.segments.get(id)!).filter((segment) => segment && segment.points.some((p) => distance(p, point) <= radius)).slice(0, limit);
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
          if (d <= nearestDistance && node.layer === properties.layer && node.bridge === properties.bridge && node.tunnel === properties.tunnel) {
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
    const cells = new Set(segment.points.map((point) => cellKey(point)));
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
