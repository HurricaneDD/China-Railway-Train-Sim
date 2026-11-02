import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, expect, it, vi } from 'vitest';
import { RailNetwork } from '../src/data/railway';
import { GameSession } from '../src/core/session';
import { validateGameSave } from '../src/core/storage';
import { fetchJson } from '../src/utils/assets';
import { distance, nearestOnSegment } from '../src/utils/geo';
import type { ProvinceInfo, Station } from '../src/types';

// Acceptance uses the original provincial files. RAF is disabled, terrain is synthetic flat,
// and movement is prescribed directly: this is not browser, physics, or real terrain evidence.
vi.mock('../src/utils/assets', () => ({ fetchJson: vi.fn() }));
const readData = (file: string) => JSON.parse(readFileSync(new URL(`../data/${file}`, import.meta.url), 'utf8'));
const report: Record<string, unknown> = {
  source: '33 original provincial GeoJSON files, read sequentially; no national merged file',
  transport: 'local fs + mocked fetchJson', terrain: 'synthetic flat, no terrain provider',
  movement: 'prescribed 0.25m forward steps via GameSession.advance; not physics or browser evidence',
};
afterAll(() => {
  vi.unstubAllGlobals();
  mkdirSync(new URL('../output/demo/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../output/demo/nationwide.json', import.meta.url), JSON.stringify(report, null, 2));
});

it('全部33省按需文件原始几何一致性、索引与代表车站吸附，以及三省真实几何运动检查', async () => {
  const started = performance.now();
  vi.mocked(fetchJson).mockImplementation(async (file) => readData(file));
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const provinces: ProvinceInfo[] = readData('provinces_index.json').provinces;
  const stations: Station[] = readData('stations.json').stations;
  const network = new RailNetwork();
  const provinceResults: Record<string, unknown>[] = [];
  let checkedParts = 0, checkedVertices = 0;
  for (const province of provinces) {
    const raw = readData(province.file);
    await network.loadProvince(province);
    let eligibleParts = 0, missingParts = 0, changedParts = 0;
    raw.features.forEach((feature: { properties: Record<string, unknown>; geometry: { type: string; coordinates: number[][][] } }, featureIndex: number) => {
      const properties = feature.properties;
      if (!(properties.code === 6101 || (properties.code === undefined && properties.fclass === 'rail')) || feature.geometry.type !== 'MultiLineString') return;
      feature.geometry.coordinates.forEach((rawPoints, partIndex) => {
        const points = rawPoints.filter(point => point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]));
        if (points.length < 2) return;
        let length = 0;
        for (let i = 1; i < points.length; i++) length += distance({ lon: points[i - 1][0], lat: points[i - 1][1] }, { lon: points[i][0], lat: points[i][1] });
        if (length < 0.1) return;
        eligibleParts++;
        const segment = network.segments.get(`${province.adcode}:${featureIndex}:${partIndex}`);
        if (!segment) { missingParts++; return; }
        if (segment.points.length !== points.length || segment.points.some((point, index) => point.lon !== points[index][0] || point.lat !== points[index][1])) changedParts++;
        checkedVertices += points.length;
        expect(network.nodes.get(segment.startNode)?.segmentIds).toContain(segment.id);
        expect(network.nodes.get(segment.endNode)?.segmentIds).toContain(segment.id);
        expect(segment.cumulative.length).toBe(segment.points.length);
        expect(segment.length).toBeGreaterThan(0);
        expect(segment.cumulative[segment.cumulative.length - 1]).toBe(segment.length);
      });
    });
    checkedParts += eligibleParts;
    const localStations = stations.filter(station => station.province === province.province);
    let representative: { name: string; distance: number; segmentId: string } | undefined;
    let attempts = 0;
    for (const station of localStations) {
      attempts++;
      const snap = network.nearest({ lon: station.longitude, lat: station.latitude }, 2500);
      if (snap) { representative = { name: station.name, distance: snap.distance, segmentId: snap.segmentId }; break; }
    }
    provinceResults.push({ province: province.province, rawFeatures: raw.features.length, eligibleParts, missingParts, changedParts,
      stations: localStations.length, stationAttempts: attempts, representativeStation: representative ?? null });
    expect(missingParts, `${province.province} missing raw parts`).toBe(0);
    expect(changedParts, `${province.province} mutated coordinates`).toBe(0);
    if (eligibleParts && localStations.length) expect(representative, `${province.province} representative station snap`).toBeDefined();
  }
  report.provinces = provinceResults;
  report.geometry = { loadedProvinces: network.loadedProvinces.size, canonicalSegments: network.segments.size,
    nodes: network.nodes.size, checkedParts, checkedVertices };
  expect(network.loadedProvinces.size).toBe(33);
  const movements: Record<string, unknown>[] = [];
  for (const stationName of ['南京南', '广州南', '乌鲁木齐']) {
    const station = stations.find(station => station.name === stationName)!;
    expect(station).toBeDefined();
    const session = new GameSession();
    Object.defineProperty(session.railway, 'network', { value: network });
    session.railway.provinces = provinces;
    session.stations.stations = stations;
    vi.spyOn(session.elevation, 'sample').mockImplementation(async points => points.map(() => 0));
    vi.spyOn(session.elevation, 'slope').mockResolvedValue(0);
    const snap = await session.startAt(station.province, { lon: station.longitude, lat: station.latitude }, 2500);
    const internals = session as unknown as { advance(distance: number): void; borderLoading?: Promise<void> };
    await internals.borderLoading;
    session.train.velocity = 10; // Only sets travel direction; displacement is prescribed below.
    session.parkingBrake = false;
    const segmentIds = new Set<string>();
    let junctionChoices = 0, steps = 0, maxStepDisplacement = 0, maxRequestedStepDifference = 0;
    const errors: string[] = [];
    session.onError = message => errors.push(message);
    while (steps < 8000 && !session.routeEnd && !session.paused) {
      if (session.junction) {
        const heading = session.currentPoint()!.heading;
        const ranked = [...session.junction.options].sort((a, b) => {
          const difference = (bearing: number) => Math.abs(((bearing - heading + 540) % 360) - 180);
          return difference(a.bearing) - difference(b.bearing) || a.segmentId.localeCompare(b.segmentId);
        });
        session.chooseJunction(ranked[0].segmentId);
        junctionChoices++;
      }
      const before = session.currentPoint()!, beforeDistance = session.position!.travelled;
      internals.advance(0.25);
      const after = session.currentPoint()!, delta = session.position!.travelled - beforeDistance;
      const displacement = distance(before, after);
      maxStepDisplacement = Math.max(maxStepDisplacement, displacement);
      maxRequestedStepDifference = Math.max(maxRequestedStepDifference, Math.abs(delta - 0.25));
      expect(delta).toBeGreaterThanOrEqual(-0.000001);
      expect(delta).toBeLessThanOrEqual(0.250001);
      // Endpoint stitching tolerance is 2m; prescribed motion must not jump beyond that allowance.
      expect(displacement).toBeLessThanOrEqual(2.251);
      expect(Number.isFinite(after.lon) && Number.isFinite(after.lat) && Number.isFinite(after.heading)).toBe(true);
      const segment = network.segments.get(session.position!.segmentId)!;
      expect(session.position!.offset).toBeGreaterThanOrEqual(-0.000001);
      expect(session.position!.offset).toBeLessThanOrEqual(segment.length + 0.000001);
      segmentIds.add(segment.id);
      steps++;
    }
    await internals.borderLoading;
    const saveValid = validateGameSave(session.createSave(`真实几何检查-${stationName}`));
    expect(saveValid).toBe(true);
    if (session.position!.travelled < 1999.999) expect(session.routeEnd || session.paused).toBe(true);
    const endpoint = session.currentPoint()!;
    const nearbyUnconnected = session.routeEnd ? network.segmentsNear(endpoint, 20, 30)
      .filter(segment => segment.id !== session.position!.segmentId)
      .map(segment => { const match = nearestOnSegment(segment, endpoint)!; return { segmentId: segment.id, name: segment.properties.name,
        distance: match.distance, offset: match.offset, length: segment.length, interior: match.offset > 2 && match.offset < segment.length - 2 }; })
      .sort((a, b) => a.distance - b.distance).slice(0, 8) : [];
    movements.push({ province: station.province, departure: stationName, snapDistance: snap.distance,
      travelled: session.position!.travelled, targetDistance: 2000, terminalSegmentId: session.position!.segmentId, steps, visitedSegments: segmentIds.size, junctionChoices,
      result: session.position!.travelled >= 1999.999 ? 'target_reached' : session.routeEnd ? 'endpoint_reached' : 'paused',
      maxStepDisplacement, maxRequestedStepDifference, saveValid, endpoint: { lon: endpoint.lon, lat: endpoint.lat }, nearbyUnconnected, visibleVehicles: session.consistPoints().length, errors });
    session.stop();
  }
  report.movements = movements;
  report.durationMs = performance.now() - started;
}, 120_000);
