import './style.css';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import {
  Viewer, Ion, Color, Cartesian3, Cartographic, Math as CM, HeadingPitchRoll, Transforms, Matrix4,
  EllipsoidTerrainProvider, CustomHeightmapTerrainProvider, GeographicTilingScheme, createWorldTerrainAsync,
  sampleTerrainMostDetailed, ClippingPolygon, ClippingPolygonCollection, Geometry, GeometryAttribute,
  GeometryAttributes, ComponentDatatype, GeometryInstance, PrimitiveType, BoundingSphere,
  ColorGeometryInstanceAttribute, PerInstanceColorAppearance, Primitive, HeadingPitchRange,
  buildModuleUrl, JulianDate, Rectangle, SingleTileImageryProvider, type TerrainProvider,
} from 'cesium';
import { APP_CONFIG } from '../../src/config';
import { offsetPoint, distance, bearing } from '../../src/utils/geo';
import route from './route.json';
import { DEFAULT_PROFILE, fitProfile, profileAt, profileMetrics, syntheticHeight, type HeightSample } from './profile';

type Point = typeof route.samples[number];
type Source = 'synthetic' | 'world';
type Mode = 'raw' | 'smooth' | 'replace';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (message: string) => { $('status').textContent = message; };
Ion.defaultAccessToken = APP_CONFIG.cesiumIonToken;
// Cesium 1.127 exposes this runtime helper but omits it from its generated declaration.
(buildModuleUrl as typeof buildModuleUrl & { setBaseUrl(url: string): void }).setBaseUrl(new URL('../../cesium/', window.location.href).href);
const viewer = new Viewer('viewer', { terrainProvider: new EllipsoidTerrainProvider(), baseLayer: false,
  animation: false, timeline: false, baseLayerPicker: false, geocoder: false, homeButton: false,
  sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false });
viewer.scene.globe.baseColor = Color.fromCssColorString('#687260');
viewer.scene.globe.depthTestAgainstTerrain = true;
viewer.scene.globe.enableLighting = true;
viewer.clock.currentTime = JulianDate.fromIso8601('2026-11-17T03:00:00Z');
viewer.scene.backgroundColor = Color.fromCssColorString('#a4b8bd');
viewer.scene.skyAtmosphere!.show = true;
const errors: string[] = [];
const loadErrors: string[] = [];
viewer.scene.renderError.addEventListener((_scene, error) => { errors.push(String(error)); status(`渲染失败：${error}`); });
window.addEventListener('error', event => errors.push(event.message));
window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));

let source: Source = 'synthetic', requestedSource: Source = 'synthetic', mode: Mode = 'raw', raw: HeightSample[] = [], fitted: HeightSample[] = [];
let terrain: TerrainProvider, generation = 0, mileage = 1250, cab = false;
let worldProvider: TerrainProvider | undefined;
let sideHeights: number[][] = [];
let measured: Record<string, unknown> = {}, tourResult: Record<string, unknown> = {};
let owned: Primitive[] = [];
const offsets = [-60, -30, -12, -4, 4, 12, 30, 60];
const rows = route.samples.filter((_p, i) => i % 2 === 0);
const center = route.samples[125];
const diagnosticTexture = document.createElement('canvas'); diagnosticTexture.width = diagnosticTexture.height = 1024;
const groundContext = diagnosticTexture.getContext('2d')!;
groundContext.fillStyle = '#81897c'; groundContext.fillRect(0, 0, 1024, 1024);
groundContext.strokeStyle = '#b2b6a7'; groundContext.lineWidth = 2;
for (let i = 0; i <= 32; i++) { groundContext.beginPath(); groundContext.moveTo(i * 32, 0); groundContext.lineTo(i * 32, 1024); groundContext.moveTo(0, i * 32); groundContext.lineTo(1024, i * 32); groundContext.stroke(); }
const gridBounds = Rectangle.fromDegrees(Math.min(...route.samples.map(p => p.lon)) - 0.01, Math.min(...route.samples.map(p => p.lat)) - 0.01,
  Math.max(...route.samples.map(p => p.lon)) + 0.01, Math.max(...route.samples.map(p => p.lat)) + 0.01);
void SingleTileImageryProvider.fromUrl(diagnosticTexture.toDataURL(), { rectangle: gridBounds }).then(provider => viewer.imageryLayers.addImageryProvider(provider));
const planar = (lon: number, lat: number) => {
  const east = (lon - center.lon) * Math.cos(center.lat * Math.PI / 180) * 111195;
  const north = (lat - center.lat) * 111195, a = center.heading * Math.PI / 180;
  return { s: 1250 + east * Math.sin(a) + north * Math.cos(a), lateral: east * Math.cos(a) - north * Math.sin(a) };
};
const synthAt = (lon: number, lat: number) => {
  const p = planar(lon, lat);
  return syntheticHeight(p.s, p.lateral);
};
const tilingScheme = new GeographicTilingScheme();
const syntheticProvider = new CustomHeightmapTerrainProvider({ width: 65, height: 65, tilingScheme,
  callback: (x, y, level) => {
    const rect = tilingScheme.tileXYToRectangle(x, y, level);
    const heights = new Float32Array(65 * 65);
    for (let j = 0; j < 65; j++) for (let i = 0; i < 65; i++) {
      const lon = CM.toDegrees(rect.west + rect.width * i / 64), lat = CM.toDegrees(rect.north - rect.height * j / 64);
      const p = planar(lon, lat);
      // Do not extrapolate the local sloping plane to planetary-scale extreme elevations.
      heights[j * 65 + i] = Math.abs(p.s - 1250) < 15000 && Math.abs(p.lateral) < 15000 ? syntheticHeight(p.s, p.lateral) : 32;
    }
    return heights;
  },
});

function locate(s: number): Point {
  const clamped = Math.max(0, Math.min(5000, s)), index = Math.min(route.samples.length - 2, Math.floor(clamped / 10));
  const a = route.samples[index], b = route.samples[index + 1], t = (clamped - a.s) / (b.s - a.s);
  return { ...a, s: clamped, lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
}

function mesh(name: string, vertices: number[], indices: number[], color: string) {
  const origin = Cartesian3.fromDegrees(center.lon, center.lat, 0), frame = Transforms.eastNorthUpToFixedFrame(origin);
  const inverse = Matrix4.inverseTransformation(frame, new Matrix4()), local: number[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    const p = Matrix4.multiplyByPoint(inverse, Cartesian3.fromDegrees(vertices[i], vertices[i + 1], vertices[i + 2]), new Cartesian3());
    local.push(p.x, p.y, p.z);
  }
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: new Float64Array(local) });
  const primitive = new Primitive({ asynchronous: false, allowPicking: false,
    geometryInstances: new GeometryInstance({ id: name, modelMatrix: frame,
      geometry: new Geometry({ attributes, indices: new Uint32Array(indices), primitiveType: PrimitiveType.TRIANGLES, boundingSphere: BoundingSphere.fromVertices(local) }),
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color)) } }),
    appearance: new PerInstanceColorAppearance({ flat: true, translucent: false, closed: false }),
  });
  viewer.scene.primitives.add(primitive); owned.push(primitive);
}

function replacementHeight(row: number, lateral: number) {
  const point = rows[row], original = sideHeights[row][offsets.indexOf(lateral)];
  const rail = profileAt(fitted, point.s).height;
  // Plateau at the formation, smooth transition to the original surface at the clipping boundary.
  const t = Math.max(0, Math.min(1, (Math.abs(lateral) - 4) / 56));
  const w = t * t * (3 - 2 * t);
  return rail - 0.6 + (original - (rail - 0.6)) * w;
}

function drawScene() {
  owned.forEach(p => viewer.scene.primitives.remove(p)); owned = [];
  viewer.entities.removeAll();
  if (viewer.scene.globe.clippingPolygons) viewer.scene.globe.clippingPolygons = new ClippingPolygonCollection();
  const active = mode === 'raw' ? raw : fitted;
  if (!active.length) return;
  if (mode === 'replace') {
    if (!ClippingPolygonCollection.isSupported(viewer.scene)) throw new Error('This device cannot clip polygons');
    // Mesh extends 2m beyond the clip footprint to cover tessellation/LOD boundary slivers.
    const footprint = [...rows.map(p => offsetPoint(p, p.heading, -58)), ...[...rows].reverse().map(p => offsetPoint(p, p.heading, 58))];
    viewer.scene.globe.clippingPolygons = new ClippingPolygonCollection({ polygons: [new ClippingPolygon({
      positions: footprint.map(p => Cartesian3.fromDegrees(p.lon, p.lat)),
    })] });
    const vertices: number[] = [], indices: number[] = [];
    rows.forEach((p, row) => offsets.forEach(lateral => {
      const q = offsetPoint(p, p.heading, lateral);
      vertices.push(q.lon, q.lat, replacementHeight(row, lateral));
    }));
    for (let row = 1; row < rows.length; row++) for (let col = 1; col < offsets.length; col++) {
      const a = (row - 1) * offsets.length + col - 1, b = a + 1, c = a + offsets.length, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    mesh('replacement', vertices, indices, '#69765e');
  }
  const strip = (a: number, b: number, up: number, color: string) => {
    const vertices: number[] = [], indices: number[] = [];
    route.samples.forEach((p, i) => {
      for (const lateral of [a, b]) {
        const q = offsetPoint(p, p.heading, lateral);
        vertices.push(q.lon, q.lat, active[i].h! + up);
      }
      if (i) { const j = i * 2; indices.push(j - 2, j, j - 1, j - 1, j, j + 1); }
    });
    mesh(`strip-${a}`, vertices, indices, color);
  };
  strip(-2.3, 2.3, -0.2, '#938670');
  strip(-0.755, -0.68, 0.18, '#e9edf0'); strip(0.68, 0.755, 0.18, '#e9edf0');
  // One batched mesh for sleepers rather than 6,000 Entities.
  const sleepers: number[] = [], sleeperIndices: number[] = [];
  for (let s = 0; s < 5000; s += 0.72) {
    const i = sleepers.length / 3;
    for (const [along, lateral] of [[-0.12, -1.3], [0.12, -1.3], [-0.12, 1.3], [0.12, 1.3]]) {
      const p = locate(s + along), q = offsetPoint(p, p.heading, lateral);
      sleepers.push(q.lon, q.lat, profileAt(active, s + along).height + 0.025);
    }
    sleeperIndices.push(i, i + 1, i + 2, i + 1, i + 3, i + 2);
  }
  mesh('sleepers', sleepers, sleeperIndices, '#a5aaa0');
  for (const lateral of [-60, 60]) viewer.entities.add({ polyline: { width: 2, material: Color.ORANGE,
    positions: rows.map((p, i) => { const q = offsetPoint(p, p.heading, lateral); return Cartesian3.fromDegrees(q.lon, q.lat, sideHeights[i][offsets.indexOf(lateral)] + 0.3); }) } });
  drawTrain(); drawProfile(); setCamera(); updateStats();
}

function drawTrain() {
  for (const entity of [...viewer.entities.values]) if (String(entity.id).startsWith('train-')) viewer.entities.remove(entity);
  const active = mode === 'raw' ? raw : fitted;
  const front = locate(mileage + 7), rear = locate(mileage - 7);
  const hf = profileAt(active, front.s).height, hr = profileAt(active, rear.s).height;
  const heading = bearing(rear, front), pitch = Math.atan2(hf - hr, distance(front, rear));
  const at = locate(mileage), midHeight = (hf + hr) / 2;
  const frame = Transforms.headingPitchRollToFixedFrame(Cartesian3.fromDegrees(at.lon, at.lat, midHeight), new HeadingPitchRoll(CM.toRadians(heading - 90), pitch, 0));
  const box = (id: string, x: number, y: number, z: number, l: number, w: number, h: number, color: string) => {
    viewer.entities.add({ id: `train-${id}`, position: Matrix4.multiplyByPoint(frame, new Cartesian3(x, y, z), new Cartesian3()),
      orientation: Transforms.headingPitchRollQuaternion(Cartesian3.fromDegrees(at.lon, at.lat, midHeight), new HeadingPitchRoll(CM.toRadians(heading - 90), pitch, 0)),
      box: { dimensions: new Cartesian3(l, w, h), material: Color.fromCssColorString(color) } });
  };
  box('body', 0, 0, 2.5, 18, 3.1, 2.5, '#48775e');
  box('roof', 0, 0, 3.85, 17, 2.9, 0.3, '#bcc5b8');
  box('cab', 8.1, 0, 2.95, 2.1, 3.15, 2.3, '#c2c9a9');
  box('front-window', 9.18, 0, 3.45, 0.03, 2.7, 0.8, '#183541');
  box('front-green', 9.19, 0, 2.65, 0.03, 3, 0.45, '#2a5e45');
  box('coupler', 9.65, 0, 0.7, 1, 0.4, 0.4, '#313b38');
  for (const x of [-6.5, -3, 0.5, 4]) for (const side of [-1, 1]) box(`window-${x}-${side}`, x, side * 1.56, 3, 1.9, 0.03, 0.7, '#1b3540');
  for (const x of [-5, 0, 4]) box(`roof-${x}`, x, 0, 4.1, 1.6, 1.2, 0.4, '#535b57');
  for (const s of [mileage - 7, mileage + 7]) {
    const a = locate(s - 1.2), b = locate(s + 1.2), p = locate(s);
    const h = profileAt(active, s).height;
    const bogieHeading = bearing(a, b);
    viewer.entities.add({ id: `train-bogie-${s}`, position: Cartesian3.fromDegrees(p.lon, p.lat, h + 0.7),
      orientation: Transforms.headingPitchRollQuaternion(Cartesian3.fromDegrees(p.lon, p.lat, h), new HeadingPitchRoll(CM.toRadians(bogieHeading - 90), 0, 0)),
      box: { dimensions: new Cartesian3(3.2, 2.5, 0.65), material: Color.fromCssColorString('#26322f') } });
    for (const along of [-1.1, 1.1]) for (const side of [-1, 1]) {
      const c = locate(s + along), q = offsetPoint(c, c.heading, side * 0.9);
      // Wheel cylinders rotate their local Z axle into the track's transverse axis.
      viewer.entities.add({ id: `train-wheel-${s}-${along}-${side}`, position: Cartesian3.fromDegrees(q.lon, q.lat, profileAt(active, c.s).height + 0.64),
        orientation: Transforms.headingPitchRollQuaternion(Cartesian3.fromDegrees(q.lon, q.lat, h), new HeadingPitchRoll(CM.toRadians(c.heading - 90), 0, Math.PI / 2)),
        cylinder: { length: 0.25, topRadius: 0.46, bottomRadius: 0.46, slices: 16, material: Color.fromCssColorString('#85908a') } });
    }
  }
}

function setCamera() {
  const p = locate(mileage), active = mode === 'raw' ? raw : fitted, h = profileAt(active, mileage).height;
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
  viewer.entities.values.forEach(entity => { if (String(entity.id).startsWith('train-')) entity.show = !cab; });
  if (cab) {
    const q = locate(mileage + 7), grade = profileAt(active, mileage).grade;
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(q.lon, q.lat, profileAt(active, q.s).height + 2.15),
      orientation: { heading: CM.toRadians(p.heading), pitch: Math.atan(grade) - 0.05, roll: 0 } });
  } else viewer.camera.lookAt(Cartesian3.fromDegrees(p.lon, p.lat, h), new HeadingPitchRange(CM.toRadians(p.heading + 120), -0.65, 190));
}

function drawProfile() {
  const canvas = $<HTMLCanvasElement>('profile'), ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const min = Math.min(...raw.map(p => p.h!), ...fitted.map(p => p.h!)) - 2;
  const max = Math.max(...raw.map(p => p.h!), ...fitted.map(p => p.h!)) + 2;
  for (const [profile, color] of [[raw, '#b8b8b8'], [fitted, '#bcf58b']] as const) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    profile.forEach((p, i) => { const x = p.s / 5000 * canvas.width, y = canvas.height - 10 - (p.h! - min) / (max - min) * (canvas.height - 20); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  }
}

function evidence() { return { baseCommit: '9c4abd0', source, requestedSource, mode, mileage, camera: cab ? 'driver-eye' : 'external', sourceHeight: source === 'synthetic' ? 'controlled synthetic field, NOT real terrain observation' : 'Cesium World Terrain sampled online',
  sourceGeometry: route.source, routeLength: route.length, sampleCount: raw.length, inferred: true, options: DEFAULT_PROFILE,
  raw: profileMetrics(raw), fitted: profileMetrics(fitted), maxCorrectionMeters: Math.max(...raw.map((p, i) => Math.abs(p.h! - fitted[i].h!))),
  entityCount: viewer.entities.values.length, ownedPrimitiveCount: owned.length, primitiveCount: viewer.scene.primitives.length,
  clippingPolygons: viewer.scene.globe.clippingPolygons?.length ?? 0, clippingSupported: ClippingPolygonCollection.isSupported(viewer.scene),
  renderErrors: errors, loadErrors, ...measured, tourResult }; }
function updateStats() {
  $('stats').textContent = JSON.stringify(evidence(), null, 2);
  if (raw.length) $('summary').textContent = `最大局部坡度：${profileMetrics(raw).maxAbsGradePermille.toFixed(1)}‰ → ${profileMetrics(fitted).maxAbsGradePermille.toFixed(1)}‰；最大高程修正 ${Math.max(...raw.map((p, i) => Math.abs(p.h! - fitted[i].h!))).toFixed(1)} m`;
}

async function load(next: Source) {
  const g = ++generation; requestedSource = next; status('准备高程与横断面，在线地形可能需要约一分钟…');
  $<HTMLSelectElement>('source').disabled = true;
  try {
    const started = performance.now();
    if (next === 'world') {
      worldProvider ??= await Promise.race([createWorldTerrainAsync(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('terrain provider timeout')), 20000))]);
      terrain = worldProvider;
    } else terrain = syntheticProvider;
    const queries = [...route.samples.map(p => ({ p, lateral: 0 })), ...rows.flatMap(p => offsets.map(lateral => ({ p, lateral })))];
    const points = queries.map(({ p, lateral }) => { const q = offsetPoint(p, p.heading, lateral); return Cartographic.fromDegrees(q.lon, q.lat); });
    if (next === 'world') {
      // Bound concurrency; no response means failure, never zero-as-measured.
      let cursor = 0;
      await Promise.race([Promise.all(Array.from({ length: 4 }, async () => {
        while (cursor < points.length) { const from = cursor; cursor += 100; await sampleTerrainMostDetailed(terrain, points.slice(from, from + 100)); }
      })), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('terrain sample timeout')), 60000))]);
    } else points.forEach(p => { p.height = synthAt(CM.toDegrees(p.longitude), CM.toDegrees(p.latitude)); });
    if (g !== generation) return;
    if (points.some(p => !Number.isFinite(p.height))) throw new Error('incomplete terrain samples');
    const sampleMs = performance.now() - started, fitStart = performance.now();
    const nextRaw = route.samples.map((p, i) => ({ s: p.s, h: points[i].height }));
    const nextFitted = fitProfile(nextRaw);
    source = next; raw = nextRaw; fitted = nextFitted; tourResult = {}; viewer.terrainProvider = terrain;
    sideHeights = rows.map((_p, row) => offsets.map((_o, col) => points[route.samples.length + row * offsets.length + col].height));
    measured = { sampleMs: Math.round(sampleMs), fitMs: +(performance.now() - fitStart).toFixed(2), queriedPoints: points.length };
    drawScene(); status(source === 'synthetic' ? '人工鼓包就绪：比较 A / B / C；不代表真实鼓包已定位。' : '在线地形采样成功：推定轨面不是实测铁路纵断面。');
  } catch (error) { loadErrors.push(String(error)); status(`实验未就绪，保留先前数据和场景：${error}`); }
  finally { $<HTMLSelectElement>('source').disabled = false; }
}

async function frames(count: number) { for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
async function stress() {
  const before = evidence(), times: number[] = [];
  for (let i = 0; i < 12; i++) {
    mode = (['raw', 'smooth', 'replace'] as Mode[])[i % 3];
    const t = performance.now(); drawScene(); times.push(performance.now() - t); await frames(3);
  }
  $<HTMLSelectElement>('mode').value = mode;
  tourResult = { ...tourResult, switches: 12, switchBuildMs: times, beforeEntities: before.entityCount, afterEntities: viewer.entities.values.length,
    ownedReady: owned.every(p => p.ready), afterOwnedPrimitives: owned.length, afterClipping: viewer.scene.globe.clippingPolygons?.length ?? 0 };
  updateStats(); return evidence();
}
async function tour() {
  const intervals: number[] = [], t = performance.now(); let previous = t;
  for (const s of [...Array.from({ length: 101 }, (_, i) => i * 50), ...Array.from({ length: 101 }, (_, i) => 5000 - i * 50)]) {
    mileage = Math.max(20, Math.min(4980, s)); drawTrain(); setCamera(); await frames(1);
    const now = performance.now(); intervals.push(now - previous); previous = now;
  }
  intervals.sort((a, b) => a - b);
  tourResult = { ...tourResult, tourFrames: intervals.length, tourMs: performance.now() - t, p95FrameMs: intervals[Math.floor(intervals.length * 0.95)],
    note: 'lab camera/model recreation workload; not production physics or live-streaming acceptance' };
  updateStats(); return evidence();
}
$<HTMLSelectElement>('source').onchange = event => { void load((event.target as HTMLSelectElement).value as Source); };
$<HTMLSelectElement>('mode').onchange = event => { mode = (event.target as HTMLSelectElement).value as Mode; drawScene(); };
$<HTMLInputElement>('mileage').oninput = event => { mileage = +(event.target as HTMLInputElement).value; $('mileage-value').textContent = `${mileage} m`; drawTrain(); setCamera(); };
$('overview').onclick = () => { cab = false; setCamera(); }; $('cab').onclick = () => { cab = true; setCamera(); };
$('tour').onclick = () => { void tour(); }; $('stress').onclick = () => { void stress(); };
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify({ ...evidence(), samples: route.samples, rawProfile: raw, fittedProfile: fitted, sideHeights }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `terrain-lab-${source}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
Object.assign(window, { terrainLab: { evidence, load, stress, tour, viewer, exportData: () => ({ ...evidence(), samples: route.samples, rawProfile: raw, fittedProfile: fitted, sideHeights }) } });
void load('synthetic');
