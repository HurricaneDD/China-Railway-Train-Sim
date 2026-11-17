import type { LonLat, RailSegment } from '../types';

/**
 * 统一铁路纵断面（纯逻辑，无 Cesium 依赖）。
 *
 * 输入是沿原始区段折线按米制里程稠密化后的地形采样，输出受坡度约束、
 * 端点锚定的一阶连续纵断面。原始 WGS84 平面线、区段身份与里程不变；
 * 桥隧属性只作为"地形不代表轨面"的分类线索，不生成虚构标高。
 * 可信度约定：surveyed 实测 > manual 人工覆盖 > inferred 推定 > unknown 未知；
 * 采样不足或锚点无法落地时返回空样本并标注 unknown，不冒充实测值。
 */
export type HeightConfidence = 'surveyed' | 'manual' | 'inferred' | 'unknown';

export interface HeightSample { s: number; h: number | null }

export interface ProfileFitOptions {
  /** 中值滤波半窗宽（m），剔除顶点级 DEM 尖峰。 */
  medianHalf: number;
  /** 三角权重平滑半窗宽（m），压低相邻坡度突变。 */
  smoothHalf: number;
  /** 推定坡度上限（rise/run）。不是全国线路标准，只是推理边界。 */
  maxGrade: number;
  /** 允许线性插值填补的最大缺测间隙（m）。 */
  maxFillGap: number;
  /** 有效采样占比低于该值时判定纵断面不可用。 */
  minCoverage: number;
}

export const DEFAULT_FIT_OPTIONS: ProfileFitOptions = {
  medianHalf: 30,
  smoothHalf: 150,
  maxGrade: 0.04,
  maxFillGap: 200,
  minCoverage: 0.6,
};

/** 来自相邻已拟合区段共享节点的端点锚点（轨面高）。 */
export interface ProfileAnchors { start?: number; end?: number }

export interface ProfileFitResult {
  /** 拟合后的纵断面样本；s 严格递增且覆盖整个区段，h 保证非空。 */
  samples: Array<{ s: number; h: number }>;
  coverage: number;
  maxAbsGrade: number;
  maxAdjacentGradeChange: number;
  conflicts: string[];
  confidence: HeightConfidence;
}

/** 沿原始区段折线按固定里程步长取查询点（不做坐标改写）。 */
export function segmentSamplePoints(segment: RailSegment, step: number): Array<{ s: number; point: LonLat }> {
  if (!(step > 0)) throw new Error('invalid densify step');
  const count = Math.max(1, Math.ceil(segment.length / step));
  const out: Array<{ s: number; point: LonLat }> = [];
  for (let i = 0; i <= count; i++) {
    const s = (i / count) * segment.length;
    out.push({ s, point: pointAtOffset(segment, s) });
  }
  return out;
}

function pointAtOffset(segment: RailSegment, s: number): LonLat {
  const target = Math.max(0, Math.min(segment.length, s));
  let low = 0, high = segment.cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (segment.cumulative[mid] <= target) low = mid;
    else high = mid;
  }
  const a = segment.points[low], b = segment.points[high];
  const span = segment.cumulative[high] - segment.cumulative[low];
  const t = span > 0 ? (target - segment.cumulative[low]) / span : 0;
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
}

/** 线性填补不超过 maxFillGap 的缺测段；更长的缺口保留 null，由覆盖率与端点检查判定可用性。 */
export function fillHeightGaps(raw: HeightSample[], maxFillGap: number): HeightSample[] {
  const out = raw.map(point => ({ ...point }));
  let i = 0;
  while (i < out.length) {
    if (out[i].h !== null) { i++; continue; }
    let end = i;
    while (end < out.length && out[end].h === null) end++;
    const before = i > 0 ? out[i - 1] : undefined;
    const after = end < out.length ? out[end] : undefined;
    if (before && after && after.s - before.s <= maxFillGap) {
      for (let k = i; k < end; k++) {
        const t = (out[k].s - before.s) / (after.s - before.s);
        out[k].h = before.h! + (after.h! - before.h!) * t;
      }
    } else if (before && !after && out[end - 1].s - before.s <= maxFillGap) {
      for (let k = i; k < end; k++) out[k].h = before.h;
    } else if (!before && after && after.s - out[i].s <= maxFillGap) {
      for (let k = i; k < end; k++) out[k].h = after.h;
    }
    i = end;
  }
  return out;
}

function medianWindow(samples: Array<{ s: number; h: number }>, half: number): Array<{ s: number; h: number }> {
  if (half <= 0) return samples.map(point => ({ ...point }));
  const out: Array<{ s: number; h: number }> = [];
  let low = 0, high = 0;
  for (let i = 0; i < samples.length; i++) {
    const center = samples[i].s;
    while (low < i && samples[low].s < center - half) low++;
    if (high < i) high = i;
    while (high + 1 < samples.length && samples[high + 1].s <= center + half) high++;
    const values = samples.slice(low, high + 1).map(point => point.h).sort((a, b) => a - b);
    const mid = values.length >> 1;
    out.push({ s: center, h: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2 });
  }
  return out;
}

function smoothWindow(samples: Array<{ s: number; h: number }>, half: number): Array<{ s: number; h: number }> {
  if (half <= 0) return samples.map(point => ({ ...point }));
  const out: Array<{ s: number; h: number }> = [];
  let low = 0, high = 0;
  for (let i = 0; i < samples.length; i++) {
    const center = samples[i].s;
    while (low < i && samples[low].s < center - half) low++;
    if (high < i) high = i;
    while (high + 1 < samples.length && samples[high + 1].s <= center + half) high++;
    let sum = 0, weight = 0;
    for (let k = low; k <= high; k++) {
      const w = Math.max(0, 1 - Math.abs(samples[k].s - center) / half);
      sum += samples[k].h * w;
      weight += w;
    }
    out.push({ s: center, h: weight > 0 ? sum / weight : samples[i].h });
  }
  return out;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function unavailable(coverage: number, reason: string): ProfileFitResult {
  return { samples: [], coverage, maxAbsGrade: 0, maxAdjacentGradeChange: 0, conflicts: [reason], confidence: 'unknown' };
}

/**
 * 鲁棒地形推定：中值剔尖峰 → 三角窗平滑 → 端点锚定 → 锥形夹取 + 局部坡度约束。
 * 锚点不可行时保留锚点（端点连续是硬要求）并输出冲突报告，不悄悄改锚点。
 */
export function fitTerrainProfile(raw: HeightSample[], options: ProfileFitOptions, anchors?: ProfileAnchors): ProfileFitResult {
  if (!(options.maxGrade > 0) || options.medianHalf < 0 || options.smoothHalf < 0 || options.maxFillGap < 0) {
    throw new Error('invalid profile options');
  }
  const points: HeightSample[] = [];
  for (const point of raw) {
    if (!Number.isFinite(point.s)) throw new Error('unordered mileage');
    if (points.length && point.s <= points[points.length - 1].s) throw new Error('unordered mileage');
    points.push({ s: point.s, h: point.h !== null && Number.isFinite(point.h) ? point.h : null });
  }
  const usable = points.filter(point => point.h !== null);
  const coverage = points.length ? usable.length / points.length : 0;
  if (points.length < 2 || usable.length < 2) return unavailable(coverage, '有效地形采样不足，纵断面不可用');
  if (coverage < options.minCoverage) return unavailable(coverage, `有效采样占比 ${(coverage * 100).toFixed(0)}% 低于阈值`);

  const filled = fillHeightGaps(points, options.maxFillGap);
  const known = filled.filter((point): point is { s: number; h: number } => point.h !== null);
  // 纵断面必须覆盖整个区段；起点/终点附近缺口过大时宁可不可用，也不虚构端点。
  if (known.length < 2) return unavailable(coverage, '填补后有效样本不足');
  if (known[0].s - points[0].s > options.maxFillGap + 1e-9) return unavailable(coverage, '起点附近缺测过大，端点不可信');
  if (points[points.length - 1].s - known[known.length - 1].s > options.maxFillGap + 1e-9) {
    return unavailable(coverage, '终点附近缺测过大，端点不可信');
  }

  const conflicts: string[] = [];
  const median = medianWindow(known, options.medianHalf);
  const smooth = smoothWindow(median, options.smoothHalf);
  const result = smooth.map(point => ({ ...point }));
  const evidenceGrades = smooth.slice(1).map((point, index) => (point.h - smooth[index].h) / (point.s - smooth[index].s));
  const evidenceMaxGrade = Math.max(0, ...evidenceGrades.map(Math.abs));
  const first = result[0], last = result[result.length - 1];
  const hasAnchors = anchors?.start !== undefined || anchors?.end !== undefined;
  if (anchors?.start !== undefined) result[0] = { s: first.s, h: anchors.start };
  if (anchors?.end !== undefined) result[result.length - 1] = { s: last.s, h: anchors.end };
  const startH = result[0].h, endH = result[result.length - 1].h;
  const spanS = result[result.length - 1].s - result[0].s;
  const anchorGap = Math.abs(endH - startH);
  if (hasAnchors && anchorGap > options.maxGrade * spanS + 1e-9) {
    // 端点连续是硬要求：保留锚点，整段按锚点线性过渡并显式报告冲突。
    conflicts.push(`端点锚点高差 ${(anchorGap / spanS * 1000).toFixed(1)}‰ 超过推定上限 ${(options.maxGrade * 1000).toFixed(1)}‰，按锚点线性过渡`);
    for (const point of result) {
      point.h = startH + (endH - startH) * (spanS > 0 ? (point.s - result[0].s) / spanS : 0);
    }
    const rampGrades = result.slice(1).map((point, index) => (point.h - result[index].h) / (point.s - result[index].s));
    return {
      samples: result,
      coverage,
      maxAbsGrade: Math.max(0, ...rampGrades.map(Math.abs)),
      maxAdjacentGradeChange: 0,
      conflicts,
      confidence: 'inferred',
    };
  }
  // 锚点可行时把中间点夹入两端构成的可行锥；地形本身超限时锥不可行，跳过。
  if (anchorGap <= options.maxGrade * spanS + 1e-9) {
    for (const point of result) {
      const low = Math.max(startH - options.maxGrade * (point.s - result[0].s), endH - options.maxGrade * (result[result.length - 1].s - point.s));
      const high = Math.min(startH + options.maxGrade * (point.s - result[0].s), endH + options.maxGrade * (result[result.length - 1].s - point.s));
      point.h = clamp(point.h, low, high);
    }
  }
  // 局部坡度约束；端点是锚点或本段地形证据，保持不动。
  for (let i = 1; i < result.length - 1; i++) {
    const limit = options.maxGrade * (result[i].s - result[i - 1].s);
    result[i].h = clamp(result[i].h, result[i - 1].h - limit, result[i - 1].h + limit);
  }
  for (let i = result.length - 2; i >= 1; i--) {
    const limit = options.maxGrade * (result[i + 1].s - result[i].s);
    result[i].h = clamp(result[i].h, result[i + 1].h - limit, result[i + 1].h + limit);
  }
  const grades = result.slice(1).map((point, index) => (point.h - result[index].h) / (point.s - result[index].s));
  const maxAbsGrade = Math.max(0, ...grades.map(Math.abs));
  if (evidenceMaxGrade > options.maxGrade + 1e-9) {
    conflicts.push(`地形证据坡度 ${(evidenceMaxGrade * 1000).toFixed(1)}‰ 超过推定上限 ${(options.maxGrade * 1000).toFixed(1)}‰，已按上限约束；可能是 DEM 噪声或缺失桥隧标注`);
  } else if (maxAbsGrade > options.maxGrade + 1e-9) {
    conflicts.push(`局部地形推定坡度 ${(maxAbsGrade * 1000).toFixed(1)}‰ 超过推定上限 ${(options.maxGrade * 1000).toFixed(1)}‰，保留地形证据`);
  }
  return {
    samples: result,
    coverage,
    maxAbsGrade,
    maxAdjacentGradeChange: Math.max(0, ...grades.slice(1).map((grade, index) => Math.abs(grade - grades[index]))),
    conflicts,
    confidence: 'inferred',
  };
}

/** 桥隧结构区段：地形不代表轨面，用两端节点锚点线性推定（洞口/桥头控制点）。 */
export function interpolatePortalProfile(length: number, startHeight: number, endHeight: number, step: number): Array<{ s: number; h: number }> {
  if (!(length > 0) || !(step > 0)) return [];
  const count = Math.max(1, Math.ceil(length / step));
  const out: Array<{ s: number; h: number }> = [];
  for (let i = 0; i <= count; i++) {
    const s = (i / count) * length;
    out.push({ s, h: startHeight + (endHeight - startHeight) * (s / length) });
  }
  return out;
}

/** 单端锚点的桥隧推定：按锚点侧已知坡度线性延伸贯穿整个结构区段。 */
export function extrapolatePortalProfile(length: number, anchorHeight: number, gradeAlongS: number, step: number): Array<{ s: number; h: number }> {
  if (!(length > 0) || !(step > 0)) return [];
  const count = Math.max(1, Math.ceil(length / step));
  const out: Array<{ s: number; h: number }> = [];
  for (let i = 0; i <= count; i++) {
    const s = (i / count) * length;
    out.push({ s, h: anchorHeight + gradeAlongS * s });
  }
  return out;
}

export function profileSampleAt(samples: HeightSample[], s: number): { height: number; gradeForward: number } | undefined {
  if (samples.length < 2) return undefined;
  const target = Math.max(samples[0].s, Math.min(samples[samples.length - 1].s, s));
  let low = 0, high = samples.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].s <= target) low = mid;
    else high = mid;
  }
  const a = samples[low], b = samples[high];
  if (a.h === null || b.h === null) return undefined;
  const span = b.s - a.s;
  const grade = span > 0 ? (b.h - a.h) / span : 0;
  return { height: a.h + grade * (target - a.s), gradeForward: grade };
}
