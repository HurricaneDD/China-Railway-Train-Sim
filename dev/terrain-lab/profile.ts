/** Experimental inferred rail profile. It is not surveyed railway elevation. */
export interface HeightSample { s: number; h: number | null }
export interface ProfileOptions { medianHalf: number; smoothHalf: number; maxGrade: number }
export const DEFAULT_PROFILE: ProfileOptions = { medianHalf: 30, smoothHalf: 150, maxGrade: 0.035 };

export function fitProfile(raw: HeightSample[], options = DEFAULT_PROFILE): HeightSample[] {
  if (raw.length < 2 || !(options.maxGrade > 0) || options.medianHalf < 0 || options.smoothHalf < 0) throw new Error('invalid profile options');
  raw.forEach((p, i) => {
    if (p.h === null || !Number.isFinite(p.h) || !Number.isFinite(p.s) || (i && p.s <= raw[i - 1].s)) throw new Error('missing height or unordered mileage');
  });
  const first = raw[0], last = raw.at(-1)!;
  if (Math.abs(last.h! - first.h!) > options.maxGrade * (last.s - first.s) + 1e-9) throw new Error('endpoint anchors incompatible with grade limit');
  const median = raw.map(p => {
    const values = raw.filter(q => Math.abs(q.s - p.s) <= options.medianHalf).map(q => q.h!).sort((a, b) => a - b);
    const mid = values.length >> 1;
    return { s: p.s, h: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2 };
  });
  // Compact triangular kernel; endpoint anchors restored below. Fit the complete padded corridor once.
  const result = median.map(p => {
    let sum = 0, weight = 0;
    for (const q of median) {
      const w = options.smoothHalf === 0 ? Number(q.s === p.s) : Math.max(0, 1 - Math.abs(q.s - p.s) / options.smoothHalf);
      sum += q.h * w; weight += w;
    }
    return { s: p.s, h: sum / weight };
  });
  result[0].h = first.h!;
  result.at(-1)!.h = last.h!;
  // Clamp to both endpoint feasible cones, then enforce the local Lipschitz bound.
  result.forEach(p => {
    const lo = Math.max(first.h! - options.maxGrade * (p.s - first.s), last.h! - options.maxGrade * (last.s - p.s));
    const hi = Math.min(first.h! + options.maxGrade * (p.s - first.s), last.h! + options.maxGrade * (last.s - p.s));
    p.h = Math.max(lo, Math.min(hi, p.h));
  });
  for (let i = 1; i < result.length; i++) {
    const a = result[i - 1], b = result[i], limit = options.maxGrade * (b.s - a.s);
    b.h = Math.max(a.h - limit, Math.min(a.h + limit, b.h));
  }
  for (let i = result.length - 2; i >= 0; i--) {
    const a = result[i], b = result[i + 1], limit = options.maxGrade * (b.s - a.s);
    a.h = Math.max(b.h - limit, Math.min(b.h + limit, a.h));
  }
  return result;
}

export function profileAt(profile: HeightSample[], s: number): { height: number; grade: number } {
  if (profile.length < 2) throw new Error('profile requires two points');
  let lo = 0, hi = profile.length - 1;
  while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (profile[mid].s <= s) lo = mid; else hi = mid; }
  const a = profile[lo], b = profile[hi];
  if (a.h === null || b.h === null) throw new Error('missing height');
  const grade = (b.h - a.h) / (b.s - a.s);
  return { height: a.h + grade * (Math.max(a.s, Math.min(b.s, s)) - a.s), grade };
}

export function profileMetrics(profile: HeightSample[]) {
  const grades = profile.slice(1).map((p, i) => (p.h! - profile[i].h!) / (p.s - profile[i].s));
  return { maxAbsGradePermille: Math.max(...grades.map(Math.abs)) * 1000,
    maxAdjacentGradeChangePermille: Math.max(0, ...grades.slice(1).map((g, i) => Math.abs(g - grades[i]))) * 1000,
    minHeight: Math.min(...profile.map(p => p.h!)), maxHeight: Math.max(...profile.map(p => p.h!)) };
}

export function syntheticHeight(s: number, lateral: number): number {
  // Repeatable 22 m bulge over a 90 m radius, superimposed on a 2 per mille grade.
  return 32 + s * 0.002 + 22 * Math.exp(-(((s - 1250) / 45) ** 2) - (lateral / 22) ** 2);
}
