import { describe, expect, it } from 'vitest';
import { GameSession } from '../src/core/session';
import { parseElectrified, parseSpeedLimit, speedLimitText, electrifiedText } from '../src/data/osmTags';
import { RailNetwork, RailwayRepository } from '../src/data/railway';
import type { ProvinceInfo, RailSegment } from '../src/types';

const formalProvince: ProvinceInfo = {
  adcode: '320000', province: '江苏省', short_name: '江苏', type: '省',
  file: 'geojson/320000-江苏省.geojson', feature_count: 1, point_count: 2, size_bytes: 1,
};
const formalFC = {
  type: 'FeatureCollection',
  features: [{
    properties: { osm_id: '1', code: 6101, layer: 0, bridge: 'F', tunnel: 'F', name: '京沪线' },
    geometry: { type: 'MultiLineString', coordinates: [[[118, 32], [118.001, 32]]] },
  }],
};
const enrichedFC = {
  ...formalFC,
  features: [{
    ...formalFC.features[0],
    properties: {
      ...formalFC.features[0].properties,
      maxspeed: '160', electrified: 'contact_line', voltage: '25000', frequency: '50',
      gauge: '1435', usage: 'main', tracks: '2',
    },
  }],
};
const mainIndex = { type: 'province_index', provinces: [formalProvince] };
const enrichedIndex = {
  type: 'enriched_province_index',
  provinces: [{ adcode: '320000', province: '江苏省', file: 'enriched/geojson/320000-江苏省.geojson' }],
};

function fetcher(responses: Record<string, unknown>) {
  return async <T>(path: string): Promise<T> => {
    if (path in responses) return responses[path] as T;
    throw new Error(`404 ${path}`);
  };
}

function staticFetcher(payload: unknown) {
  return async <T>(): Promise<T> => payload as T;
}

describe('OSM 限速标签解析', () => {
  it('纯数字按 km/h 解析', () => {
    expect(parseSpeedLimit('350')).toEqual({ kind: 'limit', kph: 350 });
    expect(parseSpeedLimit(' 80 ')).toEqual({ kind: 'limit', kph: 80 });
  });
  it('none 为不限速；空值与无法安全对应物理限速的形式一律未配置', () => {
    expect(parseSpeedLimit('none')).toEqual({ kind: 'unlimited' });
    expect(parseSpeedLimit(undefined)).toEqual({ kind: 'unconfigured' });
    expect(parseSpeedLimit('')).toEqual({ kind: 'unconfigured' });
    expect(parseSpeedLimit('variable')).toEqual({ kind: 'unconfigured' });
    expect(parseSpeedLimit('signals')).toEqual({ kind: 'unconfigured' });
    expect(parseSpeedLimit('70;80')).toEqual({ kind: 'unconfigured' });
  });
  it('界面文本转换', () => {
    expect(speedLimitText({ kind: 'limit', kph: 350.4 })).toBe('350');
    expect(speedLimitText({ kind: 'unlimited' })).toBe('不限');
    expect(speedLimitText({ kind: 'unconfigured' })).toBe('未配置');
  });
});

describe('OSM 电气化标签解析', () => {
  it('独立 voltage/frequency 键（国铁 25kV 50Hz 交流 / 轨道交通 1.5kV 直流）', () => {
    expect(parseElectrified('contact_line', '25000', '50')).toEqual({ electrified: true, detail: '25kV AC 50Hz' });
    expect(parseElectrified('contact_line', '1500', '0')).toEqual({ electrified: true, detail: '1.5kV DC' });
  });
  it('兼容复合写法 contact_line;v=25000', () => {
    expect(parseElectrified('contact_line;v=25000')).toEqual({ electrified: true, detail: '25kV AC' });
  });
  it('无电压标注时只给出电气化布尔', () => {
    expect(parseElectrified('contact_line')).toEqual({ electrified: true });
    expect(parseElectrified('yes')).toEqual({ electrified: true });
    expect(parseElectrified('rail', 'abc')).toEqual({ electrified: true });
  });
  it('no/none/缺失按未电气化处理', () => {
    expect(parseElectrified('no')).toEqual({ electrified: false });
    expect(parseElectrified(undefined)).toEqual({ electrified: false });
    expect(parseElectrified('')).toEqual({ electrified: false });
  });
  it('行程栏后缀', () => {
    expect(electrifiedText({ electrified: false })).toBe('');
    expect(electrifiedText({ electrified: true })).toBe(' · 电气化');
    expect(electrifiedText({ electrified: true, detail: '25kV AC' })).toBe(' · 电气化 25kV AC');
  });
});

describe('增强 GeoJSON 标签进入派生区段', () => {
  it('properties 携带原始 OSM 标签，空值不带入', async () => {
    const fc = {
      type: 'FeatureCollection',
      features: [{
        properties: {
          osm_id: 'hsr', code: 6101, layer: 0, bridge: 'F', tunnel: 'F',
          maxspeed: '350', electrified: 'contact_line', voltage: '25000', gauge: '1435',
          usage: 'main', service: '', tracks: '2',
        },
        geometry: { type: 'MultiLineString', coordinates: [[[118, 32], [118.001, 32]]] },
      }],
    };
    const network = new RailNetwork(staticFetcher(fc));
    await network.loadProvince(formalProvince);
    const properties = network.segments.get('320000:0:0')!.properties;
    expect(properties.maxspeed).toBe('350');
    expect(properties.electrified).toBe('contact_line');
    expect(properties.voltage).toBe('25000');
    expect(properties.gauge).toBe('1435');
    expect(properties.usage).toBe('main');
    expect(properties.tracks).toBe('2');
    expect(properties.service).toBeUndefined();
  });

  it('正式数据没有增强字段时不虚构限速', async () => {
    const network = new RailNetwork(staticFetcher(formalFC));
    await network.loadProvince(formalProvince);
    const properties = network.segments.get('320000:0:0')!.properties;
    expect(properties.maxspeed).toBeUndefined();
    expect(properties.electrified).toBeUndefined();
  });
});

describe('增强索引合并与加载回退', () => {
  it('增强索引存在时改写分省来源并加载增强文件', async () => {
    const repository = new RailwayRepository(fetcher({
      'provinces_index.json': mainIndex,
      'enriched/provinces_index.json': enrichedIndex,
      'enriched/geojson/320000-江苏省.geojson': enrichedFC,
    }));
    await repository.loadIndex();
    expect(repository.provinces[0].file).toBe('enriched/geojson/320000-江苏省.geojson');
    await repository.load('江苏省');
    expect(repository.network.segments.get('320000:0:0')!.properties.maxspeed).toBe('160');
  });

  it('增强文件 404 时自动回退正式数据，并记住本会话不再重试', async () => {
    const repository = new RailwayRepository(fetcher({
      'provinces_index.json': mainIndex,
      'enriched/provinces_index.json': enrichedIndex,
      'geojson/320000-江苏省.geojson': formalFC,
    }));
    await repository.loadIndex();
    await repository.load('江苏省');
    const segment = repository.network.segments.get('320000:0:0')!;
    expect(segment.properties.name).toBe('京沪线');
    expect(segment.properties.maxspeed).toBeUndefined();
    expect(repository.provinces[0].file).toBe('geojson/320000-江苏省.geojson');
    expect(repository.provinces[0].fallbackFile).toBeUndefined();
  });

  it('增强索引缺失时静默保持正式数据', async () => {
    const repository = new RailwayRepository(fetcher({ 'provinces_index.json': mainIndex, 'geojson/320000-江苏省.geojson': formalFC }));
    await repository.loadIndex();
    expect(repository.provinces[0].file).toBe('geojson/320000-江苏省.geojson');
    await repository.load('江苏省');
    expect(repository.network.segments.get('320000:0:0')!.properties.maxspeed).toBeUndefined();
  });
});

describe('驾驶中的当前区段限速与电气化', () => {
  function segmentWithTags(id: string, tags: Record<string, string>): RailSegment {
    return {
      id,
      points: [{ lon: 118, lat: 32 }, { lon: 118.001, lat: 32 }],
      cumulative: [0, 100], length: 100, startNode: '', endNode: '',
      properties: { province: '江苏省', osmId: '1', name: '京沪高铁', layer: 0, bridge: false, tunnel: false, ...tags },
    };
  }

  it('限速按区段缓存并随区段切换更新', () => {
    const session = new GameSession();
    session.railway.network.segments.set('320000:0:0', segmentWithTags('320000:0:0', { maxspeed: '350', electrified: 'contact_line', voltage: '25000', frequency: '50' }));
    session.railway.network.segments.set('320000:1:0', segmentWithTags('320000:1:0', {}));
    session.position = { province: '江苏省', segmentId: '320000:0:0', offset: 0, direction: 1, travelled: 0 };
    expect(session.currentSpeedLimit()).toEqual({ kind: 'limit', kph: 350 });
    expect(session.currentElectrification()).toEqual({ electrified: true, detail: '25kV AC 50Hz' });
    session.position = { province: '江苏省', segmentId: '320000:1:0', offset: 0, direction: 1, travelled: 0 };
    expect(session.currentSpeedLimit()).toEqual({ kind: 'unconfigured' });
    expect(session.currentElectrification()).toEqual({ electrified: false });
  });

  it('没有驾驶位置时返回未配置，不抛错', () => {
    const session = new GameSession();
    expect(session.currentSpeedLimit()).toEqual({ kind: 'unconfigured' });
    expect(session.currentElectrification()).toEqual({ electrified: false });
  });
});
