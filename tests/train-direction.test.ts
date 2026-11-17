import { describe, expect, it } from 'vitest';
import { aheadTelecodes, buildPairIndex, directionSuffixText, pairHint, trainParity } from '../src/data/trainDirection';
import type { Station } from '../src/types';

describe('车次奇偶行别推定', () => {
  it('车次号数字位奇偶决定行别', () => {
    expect(trainParity('G101')).toBe('down');
    expect(trainParity('G102')).toBe('up');
    expect(trainParity('K5181')).toBe('down');
    expect(trainParity('D2')).toBe('up');
    expect(trainParity('1461')).toBe('down');
    expect(trainParity('S')).toBeNull();
  });

  it('相邻经停站对累计上/下行证据，双向各自记账', () => {
    const index = buildPairIndex([
      ['G102', ['AAA', 'BBB', 'CCC']], // 双数=上行：AAA→BBB 与 BBB→CCC 为上行
      ['G103', ['AAA', 'BBB']], // 单数=下行
    ]);
    expect(pairHint(index, 'AAA', 'BBB')).toEqual({ up: 1, down: 1, dominant: null });
    expect(pairHint(index, 'BBB', 'AAA')).toEqual({ up: 1, down: 1, dominant: null });
    // AAA→BBB 上行 2 次（G102、K104）+BBB→CCC 上行
    const index2 = buildPairIndex([
      ['G102', ['AAA', 'BBB', 'CCC']],
      ['K104', ['AAA', 'BBB']],
    ]);
    expect(pairHint(index2, 'AAA', 'BBB')).toEqual({ up: 2, down: 0, dominant: null });
    expect(pairHint(index2, 'BBB', 'AAA')).toEqual({ up: 0, down: 2, dominant: null });
  });

  it('证据充足且占比达标时给出主导行别', () => {
    const trains: Array<[string, string[]]> = [];
    for (let i = 2; i <= 10; i += 2) trains.push([`G${i}`, ['AAA', 'BBB']]);
    trains.push(['G101', ['AAA', 'BBB']]);
    const index = buildPairIndex(trains);
    expect(pairHint(index, 'AAA', 'BBB')?.dominant).toBe('up');
    expect(pairHint(index, 'BBB', 'AAA')?.dominant).toBe('down');
    // 证据不足
    expect(pairHint(buildPairIndex([['G102', ['AAA', 'BBB']]]), 'AAA', 'BBB')?.dominant).toBeNull();
  });

  it('提示文本', () => {
    expect(directionSuffixText({ up: 5, down: 0, dominant: 'up' })).toBe(' · 上行方向');
    expect(directionSuffixText({ up: 0, down: 4, dominant: 'down' })).toBe(' · 下行方向');
    expect(directionSuffixText(null)).toBe('');
    expect(directionSuffixText({ up: 1, down: 1, dominant: null })).toBe('');
  });
});

describe('按出发方位角找前方站对', () => {
  const stations: Station[] = [
    { telecode: 'EEE', name: '戊站', full_name: '戊站', province: '江苏省', city: '南京市', city_raw: '', address: null, longitude: 118.68, latitude: 32.0, lon: 118.68, lat: 32.0 },
    { telecode: 'AAA', name: '甲站', full_name: '甲站', province: '江苏省', city: '南京市', city_raw: '', address: null, longitude: 118.72, latitude: 32.0, lon: 118.72, lat: 32.0 },
    { telecode: 'BBB', name: '乙站', full_name: '乙站', province: '江苏省', city: '南京市', city_raw: '', address: null, longitude: 118.78, latitude: 32.0, lon: 118.78, lat: 32.0 },
    { telecode: 'CCC', name: '丙站', full_name: '丙站', province: '江苏省', city: '南京市', city_raw: '', address: null, longitude: 118.83, latitude: 32.0, lon: 118.83, lat: 32.0 },
    { telecode: 'DDD', name: '远处', full_name: '远处站', province: '江苏省', city: '南京市', city_raw: '', address: null, longitude: 118.3, latitude: 31.6, lon: 118.3, lat: 31.6 },
  ];
  const center = { lon: 118.75, lat: 32.0 };

  it('向东（方位 90°）先乙站后丙站', () => {
    expect(aheadTelecodes(center, 90, stations)).toEqual(['BBB', 'CCC']);
  });
  it('向西（方位 270°）先甲站后戊站', () => {
    expect(aheadTelecodes(center, 270, stations)).toEqual(['AAA', 'EEE']);
  });
  it('明显偏离 travelBearing 方向的车站不参与', () => {
    const pair = aheadTelecodes(center, 90, stations, { maxBearingDelta: 5 });
    expect(pair?.includes('DDD')).toBeFalsy();
    expect(pair).toEqual(['BBB', 'CCC']);
  });
  it('该方向上没有车站时返回 null', () => {
    expect(aheadTelecodes(center, 45, stations, { maxBearingDelta: 5 })).toBeNull();
  });
});
