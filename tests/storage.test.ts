import { describe, expect, it } from 'vitest';
import { validateGameSave } from '../src/core/storage';

describe('存档校验', () => {
  it('拒绝错误版本与缺字段对象', () => {
    expect(validateGameSave(null)).toBe(false);
    expect(validateGameSave({ version: 2 })).toBe(false);
    expect(validateGameSave({ version: 1, position: {} })).toBe(false);
  });
});
