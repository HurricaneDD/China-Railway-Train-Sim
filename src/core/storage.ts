import { DEFAULT_SETTINGS, type GameSettings } from '../config';
import type { GameSave } from '../types';

const DB_NAME = 'china-railway-train-sim';
const STORE = 'saves';
const SETTINGS_KEY = 'crts-settings';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export const saveStore = {
  async list(): Promise<GameSave[]> {
    const saves = await transaction('readonly', (store) => store.getAll() as IDBRequest<GameSave[]>);
    return saves.filter(validateGameSave).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  },
  async put(save: GameSave): Promise<void> {
    if (!validateGameSave(save)) throw new Error('存档格式无效');
    await transaction('readwrite', (store) => store.put(structuredClone(save)));
  },
  async delete(id: string): Promise<void> {
    await transaction('readwrite', (store) => store.delete(id));
  },
  async latest(): Promise<GameSave | undefined> {
    return (await this.list())[0];
  },
};

export function validateGameSave(value: unknown): value is GameSave {
  if (!value || typeof value !== 'object') return false;
  const save = value as Partial<GameSave>;
  const train = save.train;
  const position = save.position;
  const finite = (input: unknown): input is number => typeof input === 'number' && Number.isFinite(input);
  if (save.version !== 1 || typeof save.id !== 'string' || typeof save.name !== 'string' || !Number.isFinite(Date.parse(save.savedAt ?? '')) || !finite(save.elapsed)) return false;
  if (!position || typeof position.segmentId !== 'string' || typeof position.province !== 'string' || !Number.isFinite(position.offset) || position.offset < 0 || !Number.isFinite(position.travelled) || (position.direction !== 1 && position.direction !== -1)) return false;
  if (!train) return false;
  const numericFields = ['velocity', 'throttle', 'brakeCommand', 'brakeActual', 'brakePipe', 'acceleration', 'tractionForce', 'brakeForce', 'resistanceForce', 'gradeForce', 'slope', 'sandRemaining'];
  const trainValues = train as unknown as Record<string, unknown>;
  if (!numericFields.every((field) => typeof trainValues[field] === 'number' && Number.isFinite(trainValues[field]))) return false;
  if (train.throttle < 0 || train.throttle > 100 || train.brakeCommand < 0 || train.brakeCommand > 100 || train.brakeActual < 0 || train.brakeActual > 100 || (train.reverser !== -1 && train.reverser !== 0 && train.reverser !== 1) || typeof train.adhesionLimited !== 'boolean') return false;
  if (!Array.isArray(save.routeHistory) || save.routeHistory.length === 0 || save.routeHistory.length > 5000) return false;
  if (!save.routeHistory.every((point) => point && ['lon', 'lat', 'height', 'heading', 'travelled'].every((field) => typeof (point as unknown as Record<string, unknown>)[field] === 'number' && Number.isFinite((point as unknown as Record<string, unknown>)[field])))) return false;
  return Array.isArray(save.consist);
}

export function loadSettings(): GameSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') } as GameSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: GameSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
