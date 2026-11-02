export function dataUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}data/${path}`, document.baseURI).toString();
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

export async function fetchJson<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(dataUrl(path), { signal: controller.signal });
    if (!response.ok) throw new Error(`数据加载失败（${response.status}）：${path}`);
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`数据加载超时，请重试：${path}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
