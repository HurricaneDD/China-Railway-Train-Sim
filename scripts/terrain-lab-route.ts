import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { RailNetwork } from '../src/data/railway';
import { nearestOnSegment, pointAt } from '../src/utils/geo';
import type { ProvinceInfo } from '../src/types';

const index = JSON.parse(await readFile('data/provinces_index.json', 'utf8'));
const province: ProvinceInfo = index.provinces.find((p: ProvinceInfo) => p.adcode === '320000');
const network = new RailNetwork(async <T>(path: string) => JSON.parse(await readFile(`data/${path}`, 'utf8')) as T);
await network.loadProvince(province);
const origin = { lon: 118.795, lat: 31.968 };
const snaps = network.segmentsNear(origin, 2000).filter(s => s.properties.name === '京沪高铁')
  .map(s => nearestOnSegment(s, origin)!).sort((a, b) => a.distance - b.distance);
if (!snaps.length) throw new Error('No sample route');

function trace(initialDirection: 1 | -1) {
  let id = snaps[0].segmentId, offset = snaps[0].offset, direction = initialDirection, travelled = 0, nextSample = 0;
  const samples: Array<Record<string, unknown>> = [], choices: Array<Record<string, unknown>> = [];
  for (let guard = 0; guard < 500 && travelled < 5000; guard++) {
    const segment = network.segments.get(id)!;
    const boundary = network.nextBoundary(id, offset, direction)!;
    const span = Math.min(Math.abs(boundary.offset - offset), 5000 - travelled);
    while (nextSample <= travelled + span + 1e-7) {
      const at = offset + direction * (nextSample - travelled), p = pointAt(segment, at);
      samples.push({ s: nextSample, lon: p.lon, lat: p.lat, heading: (p.heading + (direction < 0 ? 180 : 0)) % 360,
        segmentId: id, offset: at, direction, bridge: segment.properties.bridge, tunnel: segment.properties.tunnel });
      nextSample += 10;
    }
    travelled += span;
    if (travelled >= 5000) break;
    const exits = network.connectionsAt(id, boundary, direction).filter(c => c.valid)
      .sort((a, b) => Math.abs(a.angle) - Math.abs(b.angle) || a.key.localeCompare(b.key));
    if (!exits.length) break;
    if (exits.length > 1) choices.push({ s: travelled, candidates: exits.length, selected: exits[0].key, policy: 'lab-only straightest valid exit; not a user route choice' });
    id = exits[0].segmentId; offset = exits[0].offset; direction = exits[0].direction;
  }
  return { initialDirection, length: samples.at(-1)?.s ?? 0, samples, choices };
}
const route = [trace(1), trace(-1)].sort((a, b) => Number(b.length) - Number(a.length))[0];
const fixture = { source: 'data/geojson/320000-江苏省.geojson', baseCommit: '9c4abd0', sourceDatum: 'WGS84',
  note: 'Derived test route, not official running direction, bridge elevation or station track assignment', ...route };
await mkdir('dev/terrain-lab', { recursive: true });
await writeFile('dev/terrain-lab/route.json', JSON.stringify(fixture));
console.log(JSON.stringify({ length: route.length, samples: route.samples.length, segments: new Set(route.samples.map(p => p.segmentId)).size, choices: route.choices }, null, 2));
