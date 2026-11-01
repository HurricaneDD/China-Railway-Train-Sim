export function dataUrl(path: string): string {
  return new URL(`${import.meta.env.BASE_URL}data/${path}`, document.baseURI).toString();
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(dataUrl(path));
  if (!response.ok) throw new Error(`数据加载失败（${response.status}）：${path}`);
  return response.json() as Promise<T>;
}
