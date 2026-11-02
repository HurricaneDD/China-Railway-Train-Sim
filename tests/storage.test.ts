import { afterEach, describe, expect, it, vi } from 'vitest';
import { saveStore, validateGameSave } from '../src/core/storage';
import { APP_CONFIG } from '../src/config';
import { initialTrainState } from '../src/core/dynamics';

const validSave = () => ({
  id: 'test', name: '测试', version: 1 as const, savedAt: '2026-11-02T00:00:00Z', elapsed: 10,
  position: { province: '江苏省', segmentId: '320000:0:0', offset: 10, travelled: 10, direction: 1 as const },
  train: initialTrainState(),
  routeHistory: [
    { lon: 118, lat: 32, height: 0, heading: 90, travelled: -20 },
    { lon: 118.001, lat: 32, height: 0, heading: 90, travelled: 10 },
  ],
  consist: APP_CONFIG.train.cars,
});
afterEach(() => vi.unstubAllGlobals());

describe('存档校验', () => {
  it('拒绝错误版本与缺字段对象', () => {
    expect(validateGameSave(null)).toBe(false);
    expect(validateGameSave({ version: 2 })).toBe(false);
    expect(validateGameSave({ version: 1, position: {} })).toBe(false);
    expect(validateGameSave(validSave())).toBe(true);
  });
  it('拒绝越界坐标、倒序历史、无效编组与驾驶数值', () => {
    const invalidPoint = validSave(); invalidPoint.routeHistory[0].lon = 200;
    expect(validateGameSave(invalidPoint)).toBe(false);
    const invalidHistory = validSave(); invalidHistory.routeHistory.reverse();
    expect(validateGameSave(invalidHistory)).toBe(false);
    const invalidConsist = { ...validSave(), consist: [{ length: 20, width: 0, height: 4, mass: 100 }] };
    expect(validateGameSave(invalidConsist)).toBe(false);
    const invalidTrain = validSave(); invalidTrain.train.velocity = Infinity;
    expect(validateGameSave(invalidTrain)).toBe(false);
  });
  it('允许初始负里程与倒车后在机车前方的已知路径', () => {
    const save = validSave(); save.routeHistory.push({ ...save.routeHistory[1], travelled: 20 });
    expect(validateGameSave(save)).toBe(true);
  });
});

function fakeDatabase() {
  const request = { result: undefined, error: null, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void) };
  const store = { put: vi.fn(() => request) };
  const tx = { error: null, objectStore: () => store, oncomplete: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void) };
  const db = { transaction: () => tx, close: vi.fn() };
  const openRequest = { result: db, onsuccess: undefined as undefined | (() => void) };
  vi.stubGlobal('indexedDB', { open: () => { queueMicrotask(() => openRequest.onsuccess?.()); return openRequest; } });
  return { request, tx, db, store };
}

describe('存档事务提交', () => {
  it('request成功不提前报告保存，等待事务完成才返回', async () => {
    const fake = fakeDatabase();
    let completed = false;
    const promise = saveStore.put(validSave()).then(() => { completed = true; });
    await vi.waitFor(() => expect(fake.store.put).toHaveBeenCalledOnce());
    fake.request.onsuccess?.();
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(fake.db.close).not.toHaveBeenCalled();
    fake.tx.oncomplete?.();
    await promise;
    expect(completed).toBe(true);
    expect(fake.db.close).toHaveBeenCalledOnce();
  });
  it('request成功后事务abort仍报告失败', async () => {
    const fake = fakeDatabase();
    const promise = saveStore.put(validSave());
    const rejection = expect(promise).rejects.toThrow('存档事务已中止');
    await vi.waitFor(() => expect(fake.store.put).toHaveBeenCalledOnce());
    fake.request.onsuccess?.();
    fake.tx.onabort?.();
    await rejection;
    expect(fake.db.close).toHaveBeenCalledOnce();
  });
});

it('导入同ID时在同一事务创建副本，不覆盖已有存档', async () => {
  let onGetSuccess: (() => void) | undefined;
  const request = { result: validSave(), onsuccess: undefined as undefined | (() => void), addEventListener: (_event: string, callback: () => void) => { onGetSuccess = callback; } };
  const store = { get: vi.fn(() => request), add: vi.fn() };
  const tx = { objectStore: () => store, oncomplete: undefined as undefined | (() => void) };
  const db = { transaction: () => tx, close: vi.fn() };
  const opening = { result: db, onsuccess: undefined as undefined | (() => void) };
  vi.stubGlobal('indexedDB', { open: () => { queueMicrotask(() => opening.onsuccess?.()); return opening; } });
  const input = validSave();
  const promise = saveStore.import(input);
  await vi.waitFor(() => expect(store.get).toHaveBeenCalledWith('test'));
  onGetSuccess?.(); request.onsuccess?.();
  const added = store.add.mock.calls[0][0] as ReturnType<typeof validSave>;
  expect(added.id).not.toBe('test');
  expect(added.name).toContain('导入副本');
  expect(input.id).toBe('test');
  tx.oncomplete?.();
  expect((await promise).id).toBe(added.id);
});
