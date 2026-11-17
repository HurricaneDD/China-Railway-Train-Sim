/**
 * OSM 原始标签解析：把 data/enriched/ 增强数据里的字符串标签转成界面可用的信息。
 * 只做显示层解析，不参与拓扑、距离或存档；正式数据不含这些键，解析一律走“未配置”分支。
 */

export type SpeedLimit =
  | { kind: 'limit'; kph: number }
  | { kind: 'unlimited' }
  | { kind: 'unconfigured' };

/**
 * 解析 OSM maxspeed。只接受纯数字（OSM 数值单位即 km/h）；`none` 视为不限速；
 * `variable`/`signals`/区间多值（`70;80`）等无法安全对应物理限速，一律“未配置”。
 */
export function parseSpeedLimit(raw: string | undefined): SpeedLimit {
  const text = raw?.trim().toLowerCase();
  if (!text) return { kind: 'unconfigured' };
  if (text === 'none') return { kind: 'unlimited' };
  if (/^\d+(\.\d+)?$/.test(text)) {
    const kph = Number(text);
    if (kph > 0 && kph <= 600) return { kind: 'limit', kph };
  }
  return { kind: 'unconfigured' };
}

export function speedLimitText(limit: SpeedLimit): string {
  if (limit.kind === 'unlimited') return '不限';
  if (limit.kind === 'limit') return `${Math.round(limit.kph)}`;
  return '未配置';
}

export interface Electrification {
  electrified: boolean;
  /** 电压与制式描述，如 `25kV AC`；OSM 未标电压时为 undefined。 */
  detail?: string;
}

/**
 * 解析电气化标签。OSM 实际数据把电压/频率拆成独立键（electrified=contact_line +
 * voltage=25000 + frequency=50），也兼容旧复合写法 `contact_line;v=25000`。
 * electrified=no/none 为未电气化；有 contact_line/rail/third_rail/yes 即电气化。
 */
export function parseElectrified(raw: string | undefined, voltage?: string, frequency?: string): Electrification {
  const text = raw?.trim().toLowerCase();
  if (!text || text === 'no' || text === 'none') return { electrified: false };
  const volts = voltage?.trim() || text.match(/v=(\d+(?:\.\d+)?)/)?.[1] || '';
  const value = Number(volts);
  if (!volts || !Number.isFinite(value) || value <= 0) return { electrified: true };
  const hz = (frequency?.trim() || text.match(/f=(\d+(?:\.\d+)?)/)?.[1] || '').replace(/\.0$/, '');
  // 中国国铁干线为 25kV 交流，城市轨道多为 1.5kV/750V 直流；按电压幅值粗分制式。
  const mode = value >= 3000 ? 'AC' : 'DC';
  const kv = value % 1000 === 0 ? value / 1000 : (value / 1000).toFixed(1);
  const hzText = hz && hz !== '0' ? ` ${hz}Hz` : '';
  return { electrified: true, detail: `${kv}kV ${mode}${hzText}` };
}

/** 行程栏“线路”段的电气化后缀；未标注的线路不加后缀。 */
export function electrifiedText(electrification: Electrification): string {
  if (!electrification.electrified) return '';
  return electrification.detail ? ` · 电气化 ${electrification.detail}` : ' · 电气化';
}
