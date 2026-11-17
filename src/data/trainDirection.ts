/**
 * 行别推定（neo 增强数据）。
 *
 * 数据来自 data/enriched/timetable/trains.json（chinese-railway-gtfs，CC-BY-4.0，
 * 源自 12306 公开接口，非官方授权）。中国铁路车次号数字位奇偶即行别：
 * 双数=上行（面向北京方向），单数=下行。对相邻经停站对统计上/下行穿越次数，
 * 以多数派判定两站间的行别方位。
 *
 * 这是统计启发式：只作为始发方向按钮的参考提示，不代表信号、调度或真实行别制度；
 * 数据缺失或证据不足时返回 null，界面退回纯地理方位显示。
 */
import type { LonLat, Station } from '../types';
import { fetchJson } from '../utils/assets';

export interface TimetableDataset {
  type: 'timetable_dataset';
  metadata: { train_count?: number; source?: string; generated_at?: string };
  trains: Array<[string, string[]]>;
}

export interface PairHint {
  /** 沿“从 from 到 to”方向行驶时，上行（双数车次）与下行（单数车次）的穿越次数。 */
  up: number;
  down: number;
  dominant: 'up' | 'down' | null;
}

/** 判定所需的最少车次证据数与主导占比。 */
export const MIN_PAIR_EVIDENCE = 3;
export const DOMINANT_RATIO = 0.75;

export type PairIndex = Map<string, { up: number; down: number }>;

/** 车次号数字位的奇偶决定行别；无数字位的车次不参与统计。 */
export function trainParity(code: string): 'up' | 'down' | null {
  const digits = code.match(/\d+/)?.[0];
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value % 2 === 0 ? 'up' : 'down';
}

/** 由车次经停序列构建相邻站对的方向证据索引，键为 `from|to`。 */
export function buildPairIndex(trains: Array<[string, string[]]>): PairIndex {
  const index: PairIndex = new Map();
  const bump = (key: string, kind: 'up' | 'down') => {
    const entry = index.get(key) ?? { up: 0, down: 0 };
    entry[kind] += 1;
    index.set(key, entry);
  };
  for (const [code, stops] of trains) {
    const parity = trainParity(code);
    if (!parity) continue;
    for (let i = 1; i < stops.length; i++) {
      const from = stops[i - 1];
      const to = stops[i];
      if (!from || !to || from === to) continue;
      bump(`${from}|${to}`, parity);
      bump(`${to}|${from}`, parity === 'up' ? 'down' : 'up');
    }
  }
  return index;
}

export function pairHint(index: PairIndex, fromTele: string, toTele: string): PairHint | null {
  const entry = index.get(`${fromTele}|${toTele}`);
  if (!entry) return null;
  const total = entry.up + entry.down;
  if (total < MIN_PAIR_EVIDENCE) return { ...entry, dominant: null };
  const dominant = entry.up / total >= DOMINANT_RATIO ? 'up' : entry.down / total >= DOMINANT_RATIO ? 'down' : null;
  return { ...entry, dominant };
}

/**
 * 选取出发方向前方最近的两个车站电报码，用作行别推定的站对。
 *
 * 实现说明：一条原始区段（OSM way）通常只有 1–2 km，而相邻铁路车站往往相距
 * 5–30 km，投影到单条区段会落在端点之外，所以这里不用线投影，而是按出发方位角
 * 筛选附近车站（夹角 ≤ 50°，近似容忍线路弯曲），按直线距离取最近两站。
 */
export function aheadTelecodes(
  center: LonLat,
  travelBearing: number,
  stations: Station[],
  options: { searchRadius?: number; maxBearingDelta?: number; minSeparation?: number } = {},
): [string, string] | null {
  const searchRadius = options.searchRadius ?? 20_000;
  const maxBearingDelta = options.maxBearingDelta ?? 50;
  const minSeparation = options.minSeparation ?? 1000;
  const latLimit = searchRadius / 110_540;
  const lonLimit = searchRadius / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  const candidates: Array<{ telecode: string; distanceMeters: number }> = [];
  for (const station of stations) {
    if (!station.telecode) continue;
    const dLat = (station.latitude - center.lat) * 110_540;
    const dLon = (station.longitude - center.lon) * 111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180));
    if (Math.abs(station.latitude - center.lat) > latLimit || Math.abs(station.longitude - center.lon) > lonLimit) continue;
    const distanceMeters = Math.hypot(dLat, dLon);
    // 出发车站本身（或贴着出发点的站）不作为方向参考。
    if (distanceMeters < 300) continue;
    const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    const normalized = (bearing + 360) % 360;
    const delta = Math.abs(((normalized - travelBearing + 540) % 360) - 180);
    if (delta > maxBearingDelta) continue;
    candidates.push({ telecode: station.telecode, distanceMeters });
  }
  candidates.sort((a, b) => a.distanceMeters - b.distanceMeters);
  const first = candidates[0];
  const second = candidates.find(candidate => candidate.distanceMeters >= first.distanceMeters + minSeparation && candidate.telecode !== first.telecode);
  if (!first || !second) return null;
  return [first.telecode, second.telecode];
}

let timetablePromise: Promise<TimetableDataset | null> | null = null;

/** 惰性加载时刻表数据；任何失败返回 null（无数据时界面退回纯地理方位）。 */
export function loadTimetable(): Promise<TimetableDataset | null> {
  timetablePromise ??= (async () => {
    try {
      const data = await fetchJson<TimetableDataset>('enriched/timetable/trains.json');
      if (data?.type !== 'timetable_dataset' || !Array.isArray(data.trains)) return null;
      return data;
    } catch {
      return null;
    }
  })();
  return timetablePromise;
}

let cachedIndex: PairIndex | null = null;

export async function pairIndex(): Promise<PairIndex | null> {
  if (cachedIndex) return cachedIndex;
  const dataset = await loadTimetable();
  if (!dataset) return null;
  cachedIndex = buildPairIndex(dataset.trains);
  return cachedIndex;
}

/** 行别提示文本；无证据时返回空串（界面退回纯地理方位）。 */
export function directionSuffixText(hint: PairHint | null): string {
  if (!hint?.dominant) return '';
  return hint.dominant === 'up' ? ' · 上行方向' : ' · 下行方向';
}
