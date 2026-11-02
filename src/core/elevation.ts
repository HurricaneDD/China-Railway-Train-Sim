import { Cartographic, sampleTerrainMostDetailed, type TerrainProvider } from 'cesium';
import type { LonLat } from '../types';
import { withTimeout } from '../utils/assets';

export class ElevationService {
  private provider?: TerrainProvider;
  private cache = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  private generation = 0;

  setProvider(provider: TerrainProvider): void {
    if (provider === this.provider) return;
    this.provider = provider;
    this.generation++;
    this.cache.clear();
    this.pending.clear();
  }

  height(point: LonLat): number {
    return this.cache.get(this.key(point)) ?? 0;
  }

  /** Zero on the ellipsoid is known; zero fallback after a failed remote request is not measured. */
  hasHeight(point: LonLat): boolean {
    return !this.provider?.availability || this.cache.has(this.key(point));
  }

  async sample(points: LonLat[]): Promise<number[]> {
    const provider = this.provider;
    // Ellipsoid fallback has no availability and a well-defined zero elevation.
    if (!provider?.availability || points.length === 0) return points.map(() => 0);
    const generation = this.generation;
    const deadline = Date.now() + 12_000;
    const unique = new Map(points.map(point => [this.key(point), point]));
    const missing = [...unique.entries()].filter(([key]) => !this.cache.has(key) && !this.pending.has(key));
    const batches: Array<Array<[string, LonLat]>> = [];
    for (let start = 0; start < missing.length; start += 100) batches.push(missing.slice(start, start + 100));
    // At most four terrain batches are active for this request. Other callers reuse pending samples.
    let cursor = 0;
    const jobs = batches.map(batch => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      batch.forEach(([key]) => this.pending.set(key, promise));
      return { batch, promise, resolve };
    });
    const worker = async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        try {
          const remaining = deadline - Date.now();
          // Resolve queued jobs even when none of their requests could start within this call's budget.
          if (remaining <= 0 || generation !== this.generation) continue;
          const sampled = await withTimeout(
            sampleTerrainMostDetailed(provider, job.batch.map(([, p]) => Cartographic.fromDegrees(p.lon, p.lat))),
            Math.min(8_000, remaining), '地形采样超时',
          );
          if (generation === this.generation) sampled.forEach((cartographic, index) => {
            if (Number.isFinite(cartographic.height)) this.cache.set(job.batch[index][0], cartographic.height);
          });
        } catch {
          // Failed values stay uncached, allowing a later request to retry them.
        } finally {
          job.batch.forEach(([key]) => { if (this.pending.get(key) === job.promise) this.pending.delete(key); });
          job.resolve();
        }
      }
    };
    const waiting = [...unique.keys()].map(key => this.pending.get(key)).filter((value): value is Promise<void> => !!value);
    await Promise.all([Promise.all(waiting), ...Array.from({ length: Math.min(4, jobs.length) }, worker)]);
    return points.map(point => this.height(point));
  }

  async slope(center: LonLat, ahead: LonLat, behind: LonLat, span: number): Promise<number> {
    const heights = await this.sample([center, ahead, behind]);
    return span > 0 ? (heights[1] - heights[2]) / span : 0;
  }

  private key(point: LonLat): string {
    return `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`;
  }
}
