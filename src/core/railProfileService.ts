import type { LonLat, RailNode, RailSegment } from '../types';
import {
  DEFAULT_FIT_OPTIONS,
  extrapolatePortalProfile,
  fitTerrainProfile,
  interpolatePortalProfile,
  profileSampleAt,
  segmentSamplePoints,
  type HeightConfidence,
  type HeightSample,
  type ProfileAnchors,
  type ProfileFitOptions,
} from './railProfile';

/** 对外查询结果；纵断面不可用时返回 undefined，不把失败转换成实测零值。 */
export interface RailProfileSample {
  height: number;
  /** 沿原始区段里程增大方向的有符号坡度（rise/run）。 */
  gradeForward: number;
  confidence: HeightConfidence;
  revision: string;
}

/** 服务只需要区段与节点的只读访问；RailNetwork 结构兼容即可注入。 */
export interface RailProfileNetwork {
  segments: Map<string, RailSegment>;
  nodes: Map<string, RailNode>;
}

export interface RailProfileDiagnostics {
  segmentId: string;
  confidence: HeightConfidence;
  revision: string;
  conflicts: string[];
  coverage: number;
  maxAbsGrade: number;
  sampleCount: number;
}

interface NodeHeight {
  height: number;
  /** terrain：来自地形推定拟合；extrapolated：桥隧单端锚点延伸所得，只供其他桥隧作锚点。 */
  kind: 'terrain' | 'extrapolated';
  /** 从该节点出发沿来源区段方向行走的有符号坡度（dh/ds）。 */
  gradeFromNode: number;
}

interface CachedProfile {
  samples: Array<{ s: number; h: number }>;
  confidence: HeightConfidence;
  revision: string;
  conflicts: string[];
  coverage: number;
  maxAbsGrade: number;
}

export interface RailProfileServiceOptions {
  network: RailProfileNetwork;
  /** 批量地形采样；无法测得的点必须返回 null，不得冒充零高程。 */
  sampleTerrain: (points: LonLat[]) => Promise<Array<number | null>>;
  fit?: Partial<ProfileFitOptions>;
  densifyStep?: number;
  /** 可选持久化（neo）：把拟合结果写入 IndexedDB，重载后免重新地形采样。失败一律静默。 */
  persist?: {
    load(segmentId: string): Promise<PersistedProfile | null | undefined>;
    save(profile: PersistedProfile): Promise<void>;
  };
}

/** 持久化记录；fitFingerprint 不匹配当前拟合参数时丢弃重建。 */
export interface PersistedProfile {
  segmentId: string;
  samples: Array<{ s: number; h: number }>;
  confidence: HeightConfidence;
  coverage: number;
  maxAbsGrade: number;
  fitFingerprint: string;
  savedAt: string;
}

/**
 * 按需构建并缓存区段纵断面：地形推定段走采样→拟合，桥隧段用共享节点锚点推定。
 * 只构建当前区段及其直接相邻区段，不批量遍历已加载网络；provider 切换时整体清空。
 */
export class RailProfileService {
  private profiles = new Map<string, CachedProfile>();
  private nodeHeights = new Map<string, NodeHeight>();
  private inProgress = new Set<string>();
  private generation = 0;
  private readonly fit: ProfileFitOptions;
  private readonly step: number;
  private readonly fingerprint: string;

  constructor(private deps: RailProfileServiceOptions) {
    this.fit = { ...DEFAULT_FIT_OPTIONS, ...deps.fit };
    this.step = deps.densifyStep ?? 10;
    this.fingerprint = JSON.stringify({ version: 2, fit: this.fit, step: this.step });
  }

  get revision(): string { return `p1:g${this.generation}`; }

  /** 确保区段纵断面可用；已缓存或正在构建时立即返回。 */
  async ensure(segmentId: string): Promise<void> {
    if (this.profiles.has(segmentId) || this.inProgress.has(segmentId)) return;
    const segment = this.deps.network.segments.get(segmentId);
    if (!segment) return;
    this.inProgress.add(segmentId);
    try {
      if (await this.seedFromPersisted(segmentId, segment)) return;
      await this.ensureNeighbors(segment);
      if (!this.profiles.has(segmentId)) await this.build(segment);
    } finally {
      this.inProgress.delete(segmentId);
    }
  }

  /** 命中持久化缓存时直接重建内存剖面并登记节点锚点，跳过整段地形采样。 */
  private async seedFromPersisted(segmentId: string, segment: RailSegment): Promise<boolean> {
    let record: PersistedProfile | null | undefined;
    try {
      record = await this.deps.persist?.load(segmentId);
    } catch {
      return false;
    }
    if (!record || record.fitFingerprint !== this.fingerprint || !record.samples.length) return false;
    const profile: CachedProfile = {
      samples: record.samples,
      confidence: record.confidence,
      revision: this.revision,
      conflicts: [],
      coverage: record.coverage,
      maxAbsGrade: record.maxAbsGrade,
    };
    this.profiles.set(segmentId, profile);
    const startSample = profileSampleAt(profile.samples, 0);
    const last = record.samples[record.samples.length - 1];
    const endSample = profileSampleAt(profile.samples, last.s);
    if (startSample && Number.isFinite(startSample.height)) this.registerNode(segment.startNode, startSample.height, startSample.gradeForward, 'terrain');
    if (endSample && Number.isFinite(endSample.height)) this.registerNode(segment.endNode, endSample.height, -endSample.gradeForward, 'terrain');
    return true;
  }

  sampleRailProfile(segmentId: string, offset: number): RailProfileSample | undefined {
    const cached = this.profiles.get(segmentId);
    if (!cached || !cached.samples.length) return undefined;
    const at = profileSampleAt(cached.samples, offset);
    if (!at) return undefined;
    return { height: at.height, gradeForward: at.gradeForward, confidence: cached.confidence, revision: cached.revision };
  }

  diagnostics(segmentId: string): RailProfileDiagnostics | undefined {
    const cached = this.profiles.get(segmentId);
    if (!cached) return undefined;
    return {
      segmentId,
      confidence: cached.confidence,
      revision: cached.revision,
      conflicts: cached.conflicts,
      coverage: cached.coverage,
      maxAbsGrade: cached.maxAbsGrade,
      sampleCount: cached.samples.length,
    };
  }

  /** 影像/地形 provider 变化或需要重新推定时清空全部缓存。 */
  clear(): void {
    this.generation++;
    this.profiles.clear();
    this.nodeHeights.clear();
  }

  private async ensureNeighbors(segment: RailSegment): Promise<void> {
    for (const nodeId of [segment.startNode, segment.endNode]) {
      const node = this.deps.network.nodes.get(nodeId);
      for (const id of node?.segmentIds ?? []) {
        if (id === segment.id || this.profiles.has(id) || this.inProgress.has(id)) continue;
        const neighbor = this.deps.network.segments.get(id);
        if (neighbor) await this.build(neighbor);
      }
    }
  }

  private async build(segment: RailSegment): Promise<void> {
    if (segment.properties.bridge || segment.properties.tunnel) {
      this.buildStructured(segment);
      return;
    }
    const generation = this.generation;
    const raw = segmentSamplePoints(segment, this.step);
    const heights = await this.deps.sampleTerrain(raw.map(entry => entry.point));
    // 采样期间 provider 被切换则丢弃本次结果，防止旧数据跨代存活。
    if (generation !== this.generation) return;
    const samples: HeightSample[] = raw.map((entry, index) => ({ s: entry.s, h: heights[index] ?? null }));
    const anchors: ProfileAnchors = {};
    const startEntry = this.nodeHeights.get(segment.startNode);
    const endEntry = this.nodeHeights.get(segment.endNode);
    // 地形段只锚定地形推定的节点高程，不采用桥隧延伸值，避免误差跨结构传播。
    if (startEntry?.kind === 'terrain') anchors.start = startEntry.height;
    if (endEntry?.kind === 'terrain') anchors.end = endEntry.height;
    const fitted = fitTerrainProfile(samples, this.fit, anchors);
    if (!fitted.samples.length) return; // 采样不足不缓存，允许后续重试
    this.store(segment.id, {
      samples: fitted.samples,
      confidence: fitted.confidence,
      revision: this.revision,
      conflicts: fitted.conflicts,
      coverage: fitted.coverage,
      maxAbsGrade: fitted.maxAbsGrade,
    });
    const startGrade = profileSampleAt(fitted.samples, 0)!.gradeForward;
    this.registerNode(segment.startNode, fitted.samples[0].h, startGrade, 'terrain');
    const last = fitted.samples[fitted.samples.length - 1];
    const endGrade = profileSampleAt(fitted.samples, last.s)!.gradeForward;
    this.registerNode(segment.endNode, last.h, -endGrade, 'terrain');
  }

  /**
   * 桥隧结构区段：地形高程不代表轨面。两端锚点齐全时线性插值；
   * 只有单端锚点时按锚点侧坡度延伸，远端登记为低可信推定供后续链式解析。
   */
  private buildStructured(segment: RailSegment): void {
    const start = this.nodeHeights.get(segment.startNode);
    const end = this.nodeHeights.get(segment.endNode);
    if (start && end) {
      this.store(segment.id, {
        samples: interpolatePortalProfile(segment.length, start.height, end.height, this.step),
        confidence: 'inferred',
        revision: this.revision,
        conflicts: [],
        coverage: 1,
        maxAbsGrade: Math.abs(end.height - start.height) / Math.max(1e-9, segment.length),
      });
      return;
    }
    const anchor = start ?? end;
    if (!anchor || !(segment.length > 0)) return; // 等待相邻区段先完成
    const anchoredAtStart = !!start;
    // 从节点走向桥隧的方向与走向锚点来源区段相反，因此坡度取反。
    const walkGrade = -anchor.gradeFromNode;
    const gradeAlongS = anchoredAtStart ? walkGrade : -walkGrade;
    const samples = extrapolatePortalProfile(segment.length, anchor.height, gradeAlongS, this.step);
    if (!samples.length) return;
    const farNode = anchoredAtStart ? segment.endNode : segment.startNode;
    const farHeight = anchoredAtStart ? samples[samples.length - 1].h! : samples[0].h!;
    this.store(segment.id, {
      samples,
      confidence: 'inferred',
      revision: this.revision,
      conflicts: ['仅单端锚点，按锚点侧坡度延伸，远端为低可信推定'],
      coverage: 0,
      maxAbsGrade: Math.abs(gradeAlongS),
    });
    this.registerNode(farNode, farHeight, -gradeAlongS, 'extrapolated');
  }

  private store(segmentId: string, profile: CachedProfile): void {
    this.profiles.set(segmentId, profile);
    const persist = this.deps.persist;
    if (!persist) return;
    void persist
      .save({
        segmentId,
        samples: profile.samples.map((sample) => ({ s: sample.s, h: sample.h })),
        confidence: profile.confidence,
        coverage: profile.coverage,
        maxAbsGrade: profile.maxAbsGrade,
        fitFingerprint: this.fingerprint,
        savedAt: new Date().toISOString(),
      })
      .catch(() => {
        // 持久化失败只意味着下次重采样；剖面本身在内存中仍然有效。
      });
  }

  /** terrain 高程优先且不可被覆盖；extrapolated 只作占位，可被 terrain 升级。 */
  private registerNode(nodeId: string, height: number, gradeFromNode: number, kind: 'terrain' | 'extrapolated'): void {
    const existing = this.nodeHeights.get(nodeId);
    if (existing?.kind === 'terrain') return;
    this.nodeHeights.set(nodeId, { height, kind, gradeFromNode });
  }
}
