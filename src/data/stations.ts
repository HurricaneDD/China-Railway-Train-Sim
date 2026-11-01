import type { PendingStation, Station, StationResult } from '../types';
import { fetchJson } from '../utils/assets';

interface StationDataset {
  type: 'station_dataset';
  stations: Station[];
  pending_stations: PendingStation[];
}

export class StationRepository {
  stations: Station[] = [];
  pending: PendingStation[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    const data = await fetchJson<StationDataset>('stations.json');
    if (data.type !== 'station_dataset' || !Array.isArray(data.stations) || !Array.isArray(data.pending_stations)) {
      throw new Error('车站数据格式不正确');
    }
    this.stations = data.stations.filter((station) => Number.isFinite(station.longitude) && Number.isFinite(station.latitude));
    this.pending = data.pending_stations.map((station) => ({ ...station, pending: true as const }));
    this.loaded = true;
  }

  get provinces(): string[] {
    return [...new Set(this.stations.map((station) => station.province))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  cities(province: string): string[] {
    return [...new Set(this.stations.filter((station) => station.province === province).map((station) => station.city))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  search(query: string, province = '', city = '', limit = 60): StationResult[] {
    const normalized = query.trim().toUpperCase().replace(/\s/g, '').replace(/站$/, '');
    const pool: StationResult[] = province || city || normalized ? [...this.stations, ...this.pending] : this.stations;
    return pool
      .filter((station) => {
        if (station.pending) return !province && !city;
        return (!province || station.province === province) && (!city || station.city === city);
      })
      .map((station) => ({ station, score: this.score(station, normalized) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.station.name.localeCompare(b.station.name, 'zh-CN'))
      .slice(0, limit)
      .map((entry) => entry.station);
  }

  byCode(code: string): Station | undefined {
    return this.stations.find((station) => station.telecode === code);
  }

  nearest(point: { lon: number; lat: number }, province?: string): Station | undefined {
    let best: Station | undefined;
    let bestDistance = Infinity;
    for (const station of this.stations) {
      if (province && station.province !== province) continue;
      const d = Math.hypot((station.longitude - point.lon) * Math.cos(point.lat * Math.PI / 180), station.latitude - point.lat);
      if (d < bestDistance) {
        best = station;
        bestDistance = d;
      }
    }
    return best;
  }

  private score(station: StationResult, query: string): number {
    if (!query) return station.pending ? 0 : 1;
    const names = station.pending ? [station.name] : [station.name, station.full_name, station.name_alt ?? '', station.city, station.province];
    if (station.telecode === query) return 120;
    if (names.some((name) => name.toUpperCase().replace(/站$/, '') === query)) return 110;
    if (station.telecode.startsWith(query)) return 90;
    if (names.some((name) => name.toUpperCase().startsWith(query))) return 75;
    return names.some((name) => name.toUpperCase().includes(query)) ? 50 : 0;
  }
}
