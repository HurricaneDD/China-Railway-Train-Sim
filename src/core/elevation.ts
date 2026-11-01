import { Cartographic, sampleTerrainMostDetailed, type TerrainProvider } from 'cesium';
import type { LonLat } from '../types';

export class ElevationService {
  private provider?: TerrainProvider;
  private cache = new Map<string, number>();

  setProvider(provider: TerrainProvider): void {
    this.provider = provider;
  }

  height(point: LonLat): number {
    return this.cache.get(this.key(point)) ?? 0;
  }

  async sample(points: LonLat[]): Promise<number[]> {
    if (!this.provider || points.length === 0) return points.map(() => 0);
    const missing = points.filter((point) => !this.cache.has(this.key(point)));
    try {
      for (let start = 0; start < missing.length; start += 100) {
        const batch = missing.slice(start, start + 100);
        const sampled = await sampleTerrainMostDetailed(this.provider, batch.map((point) => Cartographic.fromDegrees(point.lon, point.lat)));
        sampled.forEach((cartographic, index) => {
          if (Number.isFinite(cartographic.height)) this.cache.set(this.key(batch[index]), cartographic.height);
        });
      }
    } catch {
      return points.map((point) => this.height(point));
    }
    return points.map((point) => this.height(point));
  }

  async slope(center: LonLat, ahead: LonLat, behind: LonLat, span: number): Promise<number> {
    const heights = await this.sample([center, ahead, behind]);
    return span > 0 ? (heights[1] - heights[2]) / span : 0;
  }

  private key(point: LonLat): string {
    return `${point.lon.toFixed(5)},${point.lat.toFixed(5)}`;
  }
}
