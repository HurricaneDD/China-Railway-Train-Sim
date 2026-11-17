/**
 * FlatGeobuf 分省数据解码（neo 加载优化）。
 *
 * 转换脚本 data/scripts/convert_fgb.mjs 保证列集合覆盖全部特征属性键
 * （缺失键为 null，运行时与 undefined 等价处理）；这里只负责把二进制
 * 反序列化为与 GeoJSON 加载相同的 FeatureCollection 形状。
 */
import { deserialize } from 'flatgeobuf/geojson';

export interface RawFgbFeature {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: [number, number][][] };
}

export interface RawFgbProvince {
  type: 'FeatureCollection';
  features: RawFgbFeature[];
}

/** Uint8Array 输入下 flatgeobuf 4.x 返回异步特征迭代器。 */
export async function deserializeFgb(buffer: ArrayBuffer): Promise<RawFgbProvince> {
  const features: RawFgbFeature[] = [];
  for await (const raw of deserialize(new Uint8Array(buffer))) {
    // 包类型声明缺 geometry 字段（运行时 GeoJSON 特征一定携带），此处显式收敛形状。
    const feature = raw as unknown as { properties?: Record<string, unknown>; geometry?: { type?: string; coordinates?: unknown } };
    features.push({
      properties: feature.properties ?? {},
      geometry: {
        type: feature.geometry?.type ?? 'MultiLineString',
        coordinates: (feature.geometry?.coordinates ?? []) as [number, number][][],
      },
    });
  }
  return { type: 'FeatureCollection', features };
}
