import { describe, expect, it } from 'vitest';
import { serialize } from 'flatgeobuf/geojson';
import { deserializeFgb } from '../src/data/flatgeobufLoader';
import { RailNetwork } from '../src/data/railway';
import type { ProvinceInfo } from '../src/types';

const formalProvince: ProvinceInfo = {
  adcode: '320000', province: '江苏省', short_name: '江苏', type: '省',
  file: 'geojson/320000-江苏省.geojson', feature_count: 2, point_count: 4, size_bytes: 1,
};

function makeFgb(features: Array<{ properties: Record<string, unknown>; coordinates: number[][] }>): ArrayBuffer {
  // 与 data/scripts/convert_fgb.mjs 相同的键并集规范化：缺省键补 null，防止整列丢失。
  const unionKeys = new Set<string>();
  for (const feature of features) for (const key of Object.keys(feature.properties)) unionKeys.add(key);
  const collection = {
    type: 'FeatureCollection',
    features: features.map(feature => ({
      type: 'Feature',
      properties: Object.fromEntries([...unionKeys].map(key => [key, feature.properties[key] ?? null])),
      geometry: { type: 'MultiLineString', coordinates: [feature.coordinates] },
    })),
  };
  return serialize(collection as never).buffer as ArrayBuffer;
}

describe('FlatGeobuf 解码', () => {
  it('属性（含增强标签）与 MultiLineString 几何逐值保留', async () => {
    const buffer = makeFgb([
      { properties: { osm_id: '1', code: 6101, layer: 0, bridge: 'F', tunnel: 'F', name: '京沪线' }, coordinates: [[118, 32], [118.001, 32]] },
      { properties: { osm_id: '2', code: 6101, layer: 1, bridge: 'T', tunnel: 'F', name: '京沪高铁', maxspeed: '350', electrified: 'contact_line', voltage: '25000', usage: 'main' }, coordinates: [[118.002, 32], [118.003, 32]] },
    ]);
    const province = await deserializeFgb(buffer);
    expect(province.type).toBe('FeatureCollection');
    expect(province.features).toHaveLength(2);
    // FGB 将缺省列省略为 undefined，运行时与 null 等价处理
    expect(province.features[0].properties.maxspeed ?? null).toBeNull();
    expect(province.features[1].properties.maxspeed).toBe('350');
    expect(province.features[1].geometry.type).toBe('MultiLineString');
    expect(province.features[1].geometry.coordinates[0][0]).toEqual([118.002, 32]);
  });

  it('loadProvince 优先加载增强 FGB，属性进入派生区段', async () => {
    const buffer = makeFgb([
      { properties: { osm_id: '1', code: 6101, layer: 0, bridge: 'F', tunnel: 'F', name: '京沪高铁', maxspeed: '350' }, coordinates: [[118, 32], [118.001, 32]] },
    ]);
    const jsonCalls: string[] = [];
    const network = new RailNetwork(
      async <T>(path: string): Promise<T> => {
        jsonCalls.push(path);
        throw new Error(`不应走到 JSON 路径：${path}`);
      },
      async (path: string): Promise<ArrayBuffer> => {
        expect(path).toBe('enriched/fgb/320000-江苏省.fgb');
        return buffer;
      },
    );
    await network.loadProvince(formalProvince);
    expect(jsonCalls).toHaveLength(0);
    expect(network.segments.get('320000:0:0')!.properties.maxspeed).toBe('350');
  });

  it('FGB 失败时自动回退 GeoJSON 加载链', async () => {
    const formal = { type: 'FeatureCollection', features: [{ properties: { osm_id: '1', code: 6101, layer: 0, bridge: 'F', tunnel: 'F', name: '京沪线' }, geometry: { type: 'MultiLineString', coordinates: [[[118, 32], [118.001, 32]]] } }] };
    const network = new RailNetwork(
      async <T>(path: string): Promise<T> => {
        expect(path).toBe('geojson/320000-江苏省.geojson');
        return formal as T;
      },
      async (): Promise<ArrayBuffer> => {
        throw new Error('404');
      },
    );
    await network.loadProvince(formalProvince);
    expect(network.segments.get('320000:0:0')!.properties.name).toBe('京沪线');
    expect(network.segments.get('320000:0:0')!.properties.maxspeed).toBeUndefined();
  });
});
