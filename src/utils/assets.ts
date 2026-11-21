export interface FetchProgress {
  loadedBytes: number;
  totalBytes: number | null;
  /** 0..1 based on Content-Length when available; otherwise 0. */
  ratio: number;
}

export type FetchProgressHandler = (progress: FetchProgress) => void;

export function dataUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}data/${path}`, document.baseURI).toString();
}

/** Static interface media (background slides) lives outside the provincial data set. */
export function mediaUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}media/${path}`, document.baseURI).toString();
}

/** Bound optional remote services without holding the driving entry indefinitely. */
export async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function fetchJson<T>(path: string, onProgress?: FetchProgressHandler): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(dataUrl(path), { signal: controller.signal });
    if (!response.ok) throw new Error(`数据加载失败（${response.status}）：${path}`);
    const totalBytes = Number(response.headers.get('content-length')) || null;
    if (!onProgress || !response.body) {
      return await response.json() as T;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let loadedBytes = 0;
    let text = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loadedBytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      const ratio = totalBytes ? Math.min(1, loadedBytes / totalBytes) : 0;
      onProgress({ loadedBytes, totalBytes, ratio });
    }
    text += decoder.decode();
    return JSON.parse(text) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`数据加载超时，请重试：${path}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
