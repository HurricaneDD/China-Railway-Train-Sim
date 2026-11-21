import { describe, expect, it } from 'vitest';
import { stationRegionLabel } from '../src/data/stations';

const base = { province: '江苏省', city: '镇江市', address: '江苏省镇江市句容市华阳街道' };

describe('车站名录地区标注', () => {
  it('普通省份显示省份和地级市', () => {
    expect(stationRegionLabel(base)).toBe('江苏省 · 镇江市');
  });

  it('直辖市用地址中的区县代替重复的市名', () => {
    expect(stationRegionLabel({ province: '北京市', city: '北京市', address: '北京市朝阳区百子湾路7号' })).toBe('北京市 朝阳区');
    expect(stationRegionLabel({ province: '上海市', city: '上海市', address: '上海市浦东新区南汇新城镇' })).toBe('上海市 浦东新区');
    expect(stationRegionLabel({ province: '天津市', city: '天津市', address: '天津市蓟州区南站路北50米' })).toBe('天津市 蓟州区');
    expect(stationRegionLabel({ province: '重庆市', city: '重庆市', address: '重庆市酉阳土家族苗族自治县409省道' })).toBe('重庆市 酉阳土家族苗族自治县');
  });

  it('直辖市地址无法解析区县时只显示一次市名', () => {
    expect(stationRegionLabel({ province: '北京市', city: '北京市', address: null })).toBe('北京市');
    expect(stationRegionLabel({ province: '北京市', city: '北京市', address: '地址不详' })).toBe('北京市');
  });
});
