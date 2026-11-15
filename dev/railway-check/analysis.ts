import type { RailNetwork } from '../../src/data/railway';
import type { LonLat, RailSegment } from '../../src/types';
import { nearestOnSegment, pointAt } from '../../src/utils/geo';

export type BreakKind = 'filtered' | 'nearby' | 'isolated';
export type BreakSeverity = 'high' | 'medium' | 'low';

export interface BreakApproach {
  segmentId: string;
  name: string;
  osmId: string;
  offset: number;
  direction: 1 | -1;
  length: number;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
}

export interface BreakCandidate {
  fromSegmentId: string;
  toSegmentId: string;
  toName: string;
  toOsmId: string;
  reason: string;
  gap: number;
  angle: number;
  to: LonLat;
  toLayer: number;
  toBridge: boolean;
  toTunnel: boolean;
}

export interface NearbyRailway extends LonLat {
  segmentId: string;
  name: string;
  osmId: string;
  province: string;
  distance: number;
  offset: number;
  interior: boolean;
  layer: number;
  bridge: boolean;
  tunnel: boolean;
  sameOsmId: boolean;
}

export interface BreakGroup {
  id: string;
  nodeId: string;
  lon: number;
  lat: number;
  kind: BreakKind;
  severity: BreakSeverity;
  title: string;
  approaches: BreakApproach[];
  candidates: BreakCandidate[];
  nearest?: NearbyRailway;
  bridgeTunnel: boolean;
}

export interface FilteredLink {
  key: string;
  fromSegmentId: string;
  fromName: string;
  fromOsmId: string;
  from: LonLat;
  fromBridge: boolean;
  fromTunnel: boolean;
  toSegmentId: string;
  toName: string;
  toOsmId: string;
  to: LonLat;
  toBridge: boolean;
  toTunnel: boolean;
  reason: string;
  gap: number;
  angle: number;
}

export interface ProvinceAnalysis {
  province: string;
  groups: BreakGroup[];
  filteredLinks: FilteredLink[];
  stats: {
    loadedProvinces: number;
    loadedSegments: number;
    provinceSegments: number;
    bridgeSegments: number;
    tunnelSegments: number;
    groups: number;
    filteredGroups: number;
    nearbyGroups: number;
    isolatedGroups: number;
    filteredLinks: number;
    attributeConflictLinks: number;
    weakComponents: number;
    largestComponent: number;
  };
}

function segmentRef(segment: RailSegment, offset: number, direction: 1 | -1): BreakApproach {
  return {
    segmentId: segment.id,
    name: segment.properties.name,
    osmId: segment.properties.osmId,
    offset,
    direction,
    length: segment.length,
    layer: segment.properties.layer,
    bridge: segment.properties.bridge,
    tunnel: segment.properties.tunnel,
  };
}

function lineTitle(names: string[]): string {
  const unique = [...new Set(names.filter(Boolean))];
  if (!unique.length) return '未命名铁路';
  return unique.length === 1 ? unique[0] : `${unique[0]} 等 ${unique.length} 条`;
}

class DisjointSet {
  private parent = new Map<string, string>();

  find(id: string): string {
    let root = this.parent.get(id) ?? id;
    if (!this.parent.has(id)) this.parent.set(id, id);
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    while (this.parent.get(id) !== root) {
      const next = this.parent.get(id)!;
      this.parent.set(id, root);
      id = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

/**
 * Analyze one province using the same derived connectivity as the driving session.
 * A "break" is an arriving direction with no valid onward exit. It is not a claim that
 * the real railway terminates there, and it is not a replacement for field verification.
 */
export function analyzeProvince(network: RailNetwork, province: string): ProvinceAnalysis {
  const groups = new Map<string, BreakGroup>();
  const filteredLinks = new Map<string, FilteredLink>();
  const disjoint = new DisjointSet();
  let provinceSegments = 0, bridgeSegments = 0, tunnelSegments = 0;
  let attributeConflictLinks = 0;

  for (const segment of network.segments.values()) {
    if (segment.properties.province !== province) continue;
    provinceSegments++;
    if (segment.properties.bridge) bridgeSegments++;
    if (segment.properties.tunnel) tunnelSegments++;
    for (const boundary of network.boundariesOf(segment.id)) {
      const at = pointAt(segment, boundary.offset);
      for (const direction of [1, -1] as const) {
        // Arriving at start while moving backwards, or at end while moving forwards.
        if (direction > 0 && boundary.offset <= 0.000001) continue;
        if (direction < 0 && boundary.offset >= segment.length - 0.000001) continue;
        const candidates = network.connectionsAt(segment.id, boundary, direction);
        const valid = candidates.filter(candidate => candidate.valid);
        for (const candidate of valid) disjoint.union(segment.id, candidate.segmentId);

        for (const candidate of candidates) {
          if (candidate.valid || candidate.reason.includes('掉头')) continue;
          const target = network.segments.get(candidate.segmentId);
          if (!target) continue;
          if (candidate.reason.includes('属性冲突')) attributeConflictLinks++;
          const key = `${segment.id}@${boundary.offset.toFixed(3)}@${direction}->${candidate.segmentId}@${candidate.offset.toFixed(3)}`;
          if (filteredLinks.has(key)) continue;
          filteredLinks.set(key, {
            key,
            fromSegmentId: segment.id,
            fromName: segment.properties.name,
            fromOsmId: segment.properties.osmId,
            from: at,
            fromBridge: segment.properties.bridge,
            fromTunnel: segment.properties.tunnel,
            toSegmentId: target.id,
            toName: target.properties.name,
            toOsmId: target.properties.osmId,
            to: pointAt(target, candidate.offset),
            toBridge: target.properties.bridge,
            toTunnel: target.properties.tunnel,
            reason: candidate.reason,
            gap: candidate.gap,
            angle: candidate.angle,
          });
        }

        if (valid.length) continue;
        const rejected = candidates.filter(candidate => !candidate.reason.includes('掉头'));
        const node = network.nodes.get(boundary.nodeId);
        const point = node ?? at;
        let group = groups.get(boundary.nodeId);
        if (!group) {
          group = {
            id: boundary.nodeId,
            nodeId: boundary.nodeId,
            lon: point.lon,
            lat: point.lat,
            kind: 'isolated',
            severity: 'low',
            title: '',
            approaches: [],
            candidates: [],
            bridgeTunnel: false,
          };
          groups.set(boundary.nodeId, group);
        }
        const ref = segmentRef(segment, boundary.offset, direction);
        if (!group.approaches.some(item => item.segmentId === ref.segmentId && Math.abs(item.offset - ref.offset) < 0.000001 && item.direction === ref.direction)) {
          group.approaches.push(ref);
        }
        group.bridgeTunnel ||= segment.properties.bridge || segment.properties.tunnel;
        for (const candidate of rejected) {
          const target = network.segments.get(candidate.segmentId);
          if (!target) continue;
          if (group.candidates.some(item => item.fromSegmentId === segment.id && item.toSegmentId === target.id &&
            Math.abs(item.gap - candidate.gap) < 0.0001 && Math.abs(item.angle - candidate.angle) < 0.001)) continue;
          group.candidates.push({
            fromSegmentId: segment.id,
            toSegmentId: target.id,
            toName: target.properties.name,
            toOsmId: target.properties.osmId,
            reason: candidate.reason,
            gap: candidate.gap,
            angle: candidate.angle,
            to: pointAt(target, candidate.offset),
            toLayer: target.properties.layer,
            toBridge: target.properties.bridge,
            toTunnel: target.properties.tunnel,
          });
          group.bridgeTunnel ||= target.properties.bridge || target.properties.tunnel;
        }
      }
    }
  }

  const output: BreakGroup[] = [];
  for (const group of groups.values()) {
    const approachIds = new Set(group.approaches.map(item => item.segmentId));
    const origin = { lon: group.lon, lat: group.lat };
    let nearest: NearbyRailway | undefined;
    for (const nearby of network.segmentsNear(origin, 100, 80)) {
      if (approachIds.has(nearby.id)) continue;
      const snap = nearestOnSegment(nearby, origin);
      if (!snap) continue;
      if (!nearest || snap.distance < nearest.distance) {
        nearest = {
          ...snap.position,
          segmentId: nearby.id,
          name: nearby.properties.name,
          osmId: nearby.properties.osmId,
          province: nearby.properties.province,
          distance: snap.distance,
          offset: snap.offset,
          interior: snap.offset > 1 && snap.offset < nearby.length - 1,
          layer: nearby.properties.layer,
          bridge: nearby.properties.bridge,
          tunnel: nearby.properties.tunnel,
          sameOsmId: nearby.properties.osmId === group.approaches[0]?.osmId,
        };
      }
    }
    group.title = lineTitle(group.approaches.map(item => item.name));
    group.nearest = nearest;
    if (group.candidates.length) group.kind = 'filtered';
    else if (nearest && nearest.distance <= 100) group.kind = 'nearby';
    else group.kind = 'isolated';
    group.severity = group.kind === 'filtered' ? 'high'
      : group.kind === 'nearby' ? (nearest && (nearest.distance <= 20 || nearest.sameOsmId) ? 'high' : 'medium')
        : 'low';
    group.bridgeTunnel ||= !!nearest && (nearest.bridge || nearest.tunnel);
    output.push(group);
  }
  output.sort((a, b) => {
    const rank: Record<BreakSeverity, number> = { high: 0, medium: 1, low: 2 };
    return rank[a.severity] - rank[b.severity] ||
      b.candidates.length - a.candidates.length ||
      a.title.localeCompare(b.title, 'zh-CN') ||
      a.id.localeCompare(b.id);
  });

  // Weak components are a structural sanity check, not route reachability.
  const componentSizes = new Map<string, number>();
  let provinceCount = 0;
  for (const segment of network.segments.values()) {
    if (segment.properties.province !== province) continue;
    provinceCount++;
    const root = disjoint.find(segment.id);
    componentSizes.set(root, (componentSizes.get(root) ?? 0) + 1);
  }
  const sizes = [...componentSizes.values()].sort((a, b) => b - a);

  return {
    province,
    groups: output,
    filteredLinks: [...filteredLinks.values()].sort((a, b) => a.fromOsmId.localeCompare(b.fromOsmId) || a.toOsmId.localeCompare(b.toOsmId)),
    stats: {
      loadedProvinces: network.loadedProvinces.size,
      loadedSegments: network.segments.size,
      provinceSegments,
      bridgeSegments,
      tunnelSegments,
      groups: output.length,
      filteredGroups: output.filter(group => group.kind === 'filtered').length,
      nearbyGroups: output.filter(group => group.kind === 'nearby').length,
      isolatedGroups: output.filter(group => group.kind === 'isolated').length,
      filteredLinks: filteredLinks.size,
      attributeConflictLinks,
      weakComponents: sizes.length,
      largestComponent: sizes[0] ?? 0,
    },
  };
}
