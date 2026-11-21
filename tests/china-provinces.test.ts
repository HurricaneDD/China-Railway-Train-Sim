import { describe, expect, it } from 'vitest';
import { CHINA_PROVINCES, CHINA_PROVINCE_VIEWBOX } from '../src/data/chinaProvinces';

describe('省级行政区划图数据', () => {
  it('覆盖 33 个可显示的省级区域，包含台湾和香港，不含澳门', () => {
    const codes = CHINA_PROVINCES.map(province => province.adcode);
    expect(CHINA_PROVINCES).toHaveLength(33);
    expect(new Set(codes).size).toBe(33);
    for (const code of ['110000', '310000', '320000', '710000', '810000']) expect(codes).toContain(code);
    expect(codes).not.toContain('820000');
    expect(CHINA_PROVINCES.find(province => province.adcode === '710000')?.name).toBe('台湾省');
  });

  it('路径、标签和视图框可用于 SVG 展示', () => {
    const [minX, minY, width, height] = CHINA_PROVINCE_VIEWBOX.split(' ').map(Number);
    expect(minX).toBe(0);
    expect(minY).toBe(0);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    for (const province of CHINA_PROVINCES) {
      expect(province.d.startsWith('M')).toBe(true);
      expect(province.d).toContain('Z');
      expect(province.lx).toBeGreaterThan(0);
      expect(province.lx).toBeLessThan(width);
      expect(province.ly).toBeGreaterThan(0);
      expect(province.ly).toBeLessThan(height);
    }
  });
});
