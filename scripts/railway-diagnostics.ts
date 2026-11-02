/** Offline, one-province, derived-graph diagnostics. Run: npx vite-node scripts/railway-diagnostics.ts 440000 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { RailNetwork } from '../src/data/railway';
import type { ProvinceInfo } from '../src/types';

const code = process.argv[2];
const index = JSON.parse(await readFile('data/provinces_index.json', 'utf8')) as { provinces: ProvinceInfo[] };
const province = index.provinces.find(item => item.adcode === code);
if (!province) throw new Error('用法：npx vite-node scripts/railway-diagnostics.ts <省份 adcode，例如 440000>');
// fetchJson expects browser URL resolution; this adapter reads only the selected local data file.
Object.assign(globalThis, { document: { baseURI: 'http://localhost/' } });
globalThis.fetch = async (input) => {
  const url = new URL(String(input));
  const suffix = decodeURIComponent(url.pathname).split('/data/')[1];
  if (suffix !== province.file) throw new Error(`拒绝读取非目标省份：${suffix}`);
  return new Response(await readFile(`data/${province.file}`, 'utf8'), { status: 200 });
};
const started = performance.now();
const graph = new RailNetwork();
await graph.loadProvince(province);
const loadedMs = performance.now() - started;
const parent = new Map([...graph.segments.keys()].map(id => [id, id]));
function root(id: string): string {
  let r = id;
  while (parent.get(r) !== r) r = parent.get(r)!;
  while (parent.get(id) !== r) { const next = parent.get(id)!; parent.set(id, r); id = next; }
  return r;
}
function union(a: string, b: string) { const ra = root(a), rb = root(b); if (ra !== rb) parent.set(ra, rb); }
const nodeArms = new Map<string, number>();
const filtered: Record<string, number> = {};
let named = 0, directedBoundaries = 0, junctions = 0, noExits = 0, accepted = 0, reversals = 0, rejectedTransitions = 0;
for (const segment of graph.segments.values()) {
  if (segment.properties.name !== '未命名铁路') named++;
  for (const boundary of graph.boundariesOf(segment.id)) {
    const arms = Number(boundary.offset > 1e-6) + Number(boundary.offset < segment.length - 1e-6);
    nodeArms.set(boundary.nodeId, (nodeArms.get(boundary.nodeId) ?? 0) + arms);
    for (const direction of [-1, 1] as const) {
      if ((direction > 0 && boundary.offset <= 1e-6) || (direction < 0 && boundary.offset >= segment.length - 1e-6)) continue;
      directedBoundaries++;
      const all = graph.connectionsAt(segment.id, boundary, direction);
      const valid = all.filter(candidate => candidate.valid);
      if (!valid.length) noExits++;
      if (valid.length > 1) junctions++;
      for (const candidate of all) {
        if (candidate.valid) { accepted++; union(segment.id, candidate.segmentId); }
        else {
          filtered[candidate.reason] = (filtered[candidate.reason] ?? 0) + 1;
          if (candidate.reason.includes('掉头')) reversals++;
          if (candidate.reason.includes('桥隧')) rejectedTransitions++;
        }
      }
    }
  }
}
const degree: Record<string, number> = {};
for (const arms of nodeArms.values()) degree[arms] = (degree[arms] ?? 0) + 1;
const components = new Map<string, number>();
for (const id of graph.segments.keys()) { const idRoot = root(id); components.set(idRoot, (components.get(idRoot) ?? 0) + 1); }
const sizes = [...components.values()].sort((a, b) => b - a);
console.log(JSON.stringify({
  province: province.province, adcode: code, segments: graph.segments.size, nodes: graph.nodes.size,
  nodeArmDegreeDistribution: degree, geometricIsolatedEndpoints: degree['1'] ?? 0,
  weakSegmentComponents: { count: sizes.length, largestSegmentCounts: sizes.slice(0, 10), definition: '忽略方向，将有效候选连接的区段并查集归并；不是端到端可达性' },
  namedSegments: named, unnamedSegments: graph.segments.size - named,
  directedBoundaries, directedBoundariesWithMultipleValidExits: junctions, directedBoundariesWithoutValidExits: noExits,
  acceptedDirectedCandidates: accepted, suspectedReverseDirectedCandidates: reversals,
  rejectedAttributeConflictDirectedCandidates: rejectedTransitions, rejectedDirectedCandidatesByReason: filtered,
  timingMs: { loadAndIndex: Math.round(loadedMs), total: Math.round(performance.now() - started) },
  caveat: '派生几何诊断，候选按进入方向计数；非真实道岔、真实桥隧断连或线路可达性。仅分析所选省份。',
}, null, 2));
