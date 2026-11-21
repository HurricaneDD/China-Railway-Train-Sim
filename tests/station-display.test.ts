import { describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../src/config';
import {
  chooseStationLabels, nearbyStations, stationLabelRect, stationLabelText, stationLabelWidth,
  type StationScreenLabel,
} from '../src/map/stationLabels';
import type { Station } from '../src/types';

function station(telecode: string, name: string, lon: number, lat: number): Station {
  return {
    telecode, name, full_name: `${name}站`, province: '江苏省', city: '南京市', city_raw: '南京市',
    address: null, lon, lat, longitude: lon, latitude: lat,
  };
}

describe('三维地图车站站名标注', () => {
  const center = { lon: 118.8, lat: 32 };
  const stations = [
    station('A', '南京南', 118.8, 32),
    station('B', '南京', 118.8, 32.005),
    station('C', '中华门', 118.8, 32.02),
    station('D', '远处站', 118.8, 32.5),
    { ...station('BAD', '无效', 0, 0), longitude: Number.NaN } as Station,
  ];

  it('驾驶渲染半径内按真实米制距离排序、限量，并过滤无效坐标', () => {
    const found = nearbyStations(stations, center, 3000, 10);
    expect(found.map(entry => entry.station.telecode)).toEqual(['A', 'B', 'C']);
    expect(found[0].distance).toBeCloseTo(0, 6);
    expect(found[1].distance).toBeCloseTo(556, 0);
    expect(nearbyStations(stations, center, 3000, 2).map(entry => entry.station.telecode)).toEqual(['A', 'B']);
    expect(nearbyStations(stations, center, 0, 10)).toEqual([]);
    expect(nearbyStations(stations, center, 3000, 0)).toEqual([]);
    // The helper is read-only; the caller's station list keeps its order.
    expect(stations.map(entry => entry.telecode)).toEqual(['A', 'B', 'C', 'D', 'BAD']);
  });

  it('站名补“站”、超长截断，宽度估算考虑中英文差异', () => {
    const longName = '这是一个超过十四个字的超长车站名称';
    const label = stationLabelText(longName);
    expect(label.length).toBeLessThanOrEqual(14);
    expect(label.endsWith('…站')).toBe(true);
    expect(stationLabelText('  南京南  ')).toBe('南京南站');
    expect(stationLabelText('南京南站')).toBe('南京南站');
    expect(stationLabelWidth('南京南站')).toBeGreaterThan(stationLabelWidth('京'));
    expect(stationLabelWidth('Nanjing')).toBeGreaterThan(stationLabelWidth('N'));
    expect(APP_CONFIG.stationLabels.fontSize).toBeGreaterThanOrEqual(16);
  });

  it('标签屏幕框位于站点上方，重叠时保留优先级更高的标签', () => {
    const rect = stationLabelRect({ x: 400, y: 300, width: 60 });
    expect(rect.top).toBeLessThan(300);
    expect(rect.bottom).toBe(288);
    expect(rect.left).toBe(370);
    expect(rect.right).toBe(430);

    const labels: StationScreenLabel[] = [
      { telecode: 'A', text: '南京', x: 400, y: 300, width: 60, priority: 1 },
      { telecode: 'B', text: '南京南', x: 408, y: 300, width: 70, priority: 0 },
      { telecode: 'C', text: '中华门', x: 620, y: 300, width: 60, priority: 2 },
    ];
    expect(chooseStationLabels(labels, { width: 800, height: 600 }, 10)).toEqual(['B', 'C']);
    expect(chooseStationLabels(labels, { width: 800, height: 600 }, 1)).toEqual(['B']);
    expect(chooseStationLabels(labels, { width: 800, height: 600 }, 0)).toEqual([]);
  });

  it('屏幕外标签不参与布局，显示/渲染距离保持渲染半径更大', () => {
    const offscreen: StationScreenLabel[] = [
      { telecode: 'OFF', text: '屏外', x: -100, y: 300, width: 60, priority: 0 },
      { telecode: 'A', text: '南京', x: 400, y: 300, width: 60, priority: 1 },
    ];
    expect(chooseStationLabels(offscreen, { width: 800, height: 600 }, 10)).toEqual(['A']);
    const config = APP_CONFIG.stationLabels;
    expect(config.renderDistance).toBeGreaterThan(config.displayDistance);
    expect(config.displayDistance).toBeGreaterThan(config.refreshDistance);
    expect(config.maxDrivingStations).toBeGreaterThanOrEqual(config.maxVisibleLabels);
  });
});
