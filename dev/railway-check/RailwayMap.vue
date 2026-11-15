<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { LonLat, RailSegment, Station } from '../../src/types';
import { BasemapTiles } from '../../src/map/canvasLayer';
import { gcj02ToWgs84, wgs84ToGcj02 } from '../../src/utils/gcj02';
import { BASEMAPS, type InspectorBasemap } from './basemap';
import { metresPerWorldUnit, projectMercator, tileZoomForScale, unprojectMercator, type WorldPoint } from './mercator';
import { STATION_MIN_TILE_ZOOM, stationLabel, stationWorldPoints, type StationWorldPoint } from './stationLabels';
import type { BreakGroup, FilteredLink } from './analysis';

const props = defineProps<{
  segments: RailSegment[];
  contextSegments: RailSegment[];
  breaks: BreakGroup[];
  filteredLinks: FilteredLink[];
  selectedId: string | null;
  showFiltered: boolean;
  showBridgeTunnel: boolean;
  showIsolated: boolean;
  basemap: InspectorBasemap;
  stations: Station[];
  showStations: boolean;
}>();
const emit = defineEmits<{ select: [id: string | null]; cursor: [lon: number | null, lat: number | null] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const hoverCanvas = ref<HTMLCanvasElement>();
const view = ref({ cx: 0, cy: 0, scale: 1 });
const size = ref({ width: 0, height: 0 });
const hoverId = ref<string | null>(null);
const tooltip = ref({ x: 0, y: 0 });
const cursor = ref<{ lon: number; lat: number } | null>(null);
const tileState = ref<'loading' | 'ready' | 'error'>('loading');

let ctx: CanvasRenderingContext2D | null = null;
let hoverCtx: CanvasRenderingContext2D | null = null;
let resizeObserver: ResizeObserver | undefined;
let renderFrame = 0;
let fitScale = 1;
let bounds = { west: 0, south: 0, east: 1, north: 1 };
let allPath = new Path2D();
let groundPath = new Path2D();
let bridgePath = new Path2D();
let tunnelPath = new Path2D();
let contextPath = new Path2D();
let dragging = false;
let dragStart = { x: 0, y: 0 };
let dragCentre = { x: 0, y: 0 };
let dragDistance = 0;
let pointerDownId: number | null = null;
let disposed = false;

const tiles = new BasemapTiles();
const provider = computed(() => BASEMAPS[props.basemap]);
const visibleBreaks = computed(() => props.breaks.filter(group => props.showIsolated || group.kind !== 'isolated' || group.id === props.selectedId));
const hovered = computed(() => visibleBreaks.value.find(group => group.id === hoverId.value));
const basemapNotice = computed(() => !props.segments.length ? '' : tileState.value === 'error'
  ? '高德底图加载失败；线路与断点仍可显示'
  : tileState.value === 'loading' ? '高德底图加载中…' : '');

/**
 * AMap tiles are GCJ-02. Only the display copy is shifted; every analysis,
 * station record, save and detail panel remains WGS84.
 */
function displayPoint(point: LonLat): LonLat {
  return provider.value.coordinateSystem === 'gcj02' ? wgs84ToGcj02(point) : point;
}

function displayWorld(point: LonLat): WorldPoint {
  const display = displayPoint(point);
  return projectMercator(display.lon, display.lat);
}

function screenOfWorld(world: WorldPoint): { x: number; y: number } {
  return {
    x: size.value.width / 2 + (world.x - view.value.cx) * view.value.scale,
    y: size.value.height / 2 + (world.y - view.value.cy) * view.value.scale,
  };
}

function screenOf(point: LonLat): { x: number; y: number } {
  return screenOfWorld(displayWorld(point));
}

function worldAt(x: number, y: number): { x: number; y: number } {
  return {
    x: view.value.cx + (x - size.value.width / 2) / view.value.scale,
    y: view.value.cy + (y - size.value.height / 2) / view.value.scale,
  };
}

/** Display-frame coordinate (GCJ-02 when using AMap). */
function displayLonLatAt(x: number, y: number): LonLat {
  const point = worldAt(x, y);
  return unprojectMercator(point.x, point.y);
}

/** WGS84 coordinate under the pointer, shown to the user and emitted as data. */
function wgs84At(x: number, y: number): LonLat {
  const display = displayLonLatAt(x, y);
  return provider.value.coordinateSystem === 'gcj02' ? gcj02ToWgs84(display) : display;
}

const positionedBreaks = computed(() => visibleBreaks.value.map(group => ({
  group,
  world: displayWorld({ lon: group.lon, lat: group.lat }),
})));

const positionedStations = computed<StationWorldPoint[]>(() => stationWorldPoints(props.stations, provider.value.coordinateSystem)
  .sort((a, b) => a.world.y - b.world.y || a.world.x - b.world.x));

function addSegment(path: Path2D, segment: RailSegment): void {
  segment.points.forEach((point, index) => {
    const projected = displayWorld(point);
    if (index === 0) path.moveTo(projected.x, projected.y);
    else path.lineTo(projected.x, projected.y);
  });
}

function rebuildPaths(): void {
  allPath = new Path2D();
  groundPath = new Path2D();
  bridgePath = new Path2D();
  tunnelPath = new Path2D();
  contextPath = new Path2D();
  if (!props.segments.length) {
    bounds = { west: 0, south: 0, east: 1, north: 1 };
    return;
  }
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const segment of props.segments) {
    for (const point of segment.points) {
      const projected = displayWorld(point);
      west = Math.min(west, projected.x);
      east = Math.max(east, projected.x);
      south = Math.min(south, projected.y);
      north = Math.max(north, projected.y);
    }
  }
  if (!Number.isFinite(west)) {
    bounds = { west: 0, south: 0, east: 1, north: 1 };
    return;
  }
  // Web Mercator world coordinates: x grows east, y grows south.
  bounds = { west, south, east, north };
  for (const segment of props.segments) {
    addSegment(allPath, segment);
    if (segment.properties.tunnel) addSegment(tunnelPath, segment);
    else if (segment.properties.bridge) addSegment(bridgePath, segment);
    else addSegment(groundPath, segment);
  }
  for (const segment of props.contextSegments) addSegment(contextPath, segment);
}

function fit(): void {
  if (!props.segments.length || !size.value.width || !size.value.height) return;
  const spanX = Math.max(0.000001, bounds.east - bounds.west);
  const spanY = Math.max(0.000001, bounds.north - bounds.south);
  const scale = Math.min((size.value.width - 72) / spanX, (size.value.height - 72) / spanY);
  fitScale = Math.max(0.01, scale);
  view.value = {
    cx: (bounds.west + bounds.east) / 2,
    cy: (bounds.south + bounds.north) / 2,
    scale: fitScale,
  };
  requestRender();
}

function focus(lon: number, lat: number, zoom = 14): void {
  const point = displayWorld({ lon, lat });
  view.value = {
    cx: point.x,
    cy: point.y,
    scale: Math.max(view.value.scale, fitScale * zoom),
  };
  requestRender();
}

function zoomBy(factor: number, centerX = size.value.width / 2, centerY = size.value.height / 2): void {
  const before = worldAt(centerX, centerY);
  const next = Math.max(fitScale * 0.7, Math.min(fitScale * 2400, view.value.scale * factor));
  view.value = {
    cx: before.x - (centerX - size.value.width / 2) / next,
    cy: before.y - (centerY - size.value.height / 2) / next,
    scale: next,
  };
  requestRender();
}

function zoomIn(): void { zoomBy(1.5); }
function zoomOut(): void { zoomBy(1 / 1.5); }

function resize(): void {
  const element = host.value;
  const target = canvas.value;
  if (!element || !target) return;
  const rect = element.getBoundingClientRect();
  size.value = { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  target.width = Math.round(size.value.width * ratio);
  target.height = Math.round(size.value.height * ratio);
  target.style.width = `${size.value.width}px`;
  target.style.height = `${size.value.height}px`;
  ctx = target.getContext('2d');
  ctx?.setTransform(ratio, 0, 0, ratio, 0, 0);
  const overlay = hoverCanvas.value;
  if (overlay) {
    overlay.width = target.width;
    overlay.height = target.height;
    overlay.style.width = target.style.width;
    overlay.style.height = target.style.height;
    hoverCtx = overlay.getContext('2d');
    hoverCtx?.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawHoverOverlay();
  }
  requestRender();
}

function requestRender(): void {
  if (disposed || renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    draw();
  });
}

function drawBasemap(): void {
  if (!ctx) return;
  const status = tiles.draw(ctx, view.value, size.value.width, size.value.height, provider.value, requestRender);
  if (tileState.value !== status) tileState.value = status;
  if (status !== 'ready') return;
  const { width, height } = size.value;
  ctx.fillStyle = props.basemap === 'amap-satellite' ? 'rgba(1, 5, 3, .30)' : 'rgba(2, 7, 4, .44)';
  ctx.fillRect(0, 0, width, height);

  ctx.font = '9px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const text = provider.value.attribution;
  const textWidth = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(10, 15, 11, .74)';
  ctx.fillRect(width - textWidth - 14, height - 64, textWidth + 8, 14);
  ctx.fillStyle = 'rgba(235, 242, 231, .78)';
  ctx.fillText(text, width - textWidth - 10, height - 53);
}

function linePath(path: Path2D, color: string, width: number, dash: number[] = []): void {
  if (!ctx) return;
  ctx.save();
  ctx.translate(size.value.width / 2, size.value.height / 2);
  ctx.scale(view.value.scale, view.value.scale);
  ctx.translate(-view.value.cx, -view.value.cy);
  ctx.strokeStyle = color;
  ctx.lineWidth = width / view.value.scale;
  ctx.setLineDash(dash.map(value => value / view.value.scale));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke(path);
  ctx.restore();
}

function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw));
  const fraction = raw / 10 ** exponent;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return nice * 10 ** exponent;
}

function drawGrid(): void {
  if (!ctx) return;
  const { width, height } = size.value;
  const topLeft = displayLonLatAt(0, 0);
  const bottomRight = displayLonLatAt(width, height);
  const west = Math.min(topLeft.lon, bottomRight.lon);
  const east = Math.max(topLeft.lon, bottomRight.lon);
  const north = Math.max(topLeft.lat, bottomRight.lat);
  const south = Math.min(topLeft.lat, bottomRight.lat);
  const span = Math.max(east - west, north - south);
  const step = niceStep(span / 8);
  const displaySuffix = provider.value.coordinateSystem === 'gcj02' ? ' GCJ' : '';
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, .9)';
  ctx.strokeStyle = 'rgba(216, 255, 98, .2)';
  ctx.lineWidth = 1;
  const startLon = Math.ceil(west / step) * step;
  const startLat = Math.ceil(south / step) * step;
  for (let lon = startLon; lon <= east + step * 0.001; lon += step) {
    const { x } = screenOfWorld(projectMercator(lon, 0));
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    const label = Math.abs(step) < 0.01 ? lon.toFixed(4) : Math.abs(step) < 0.1 ? lon.toFixed(3) : lon.toFixed(2);
    ctx.fillText(`${label}°E${displaySuffix}`, x + 4, height - 10);
  }
  for (let lat = startLat; lat <= north + step * 0.001; lat += step) {
    const { y } = screenOfWorld(projectMercator(0, lat));
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    const label = Math.abs(step) < 0.01 ? lat.toFixed(4) : Math.abs(step) < 0.1 ? lat.toFixed(3) : lat.toFixed(2);
    ctx.fillText(`${label}°N${displaySuffix}`, 8, y - 4);
  }

  // Scale bar in metres at the map centre; Web Mercator scale varies with latitude.
  const centre = wgs84At(width / 2, height / 2);
  const metresPerPixel = metresPerWorldUnit(centre.lat) / view.value.scale;
  const choices = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000];
  const target = metresPerPixel * 120;
  const metres = choices.reduce((best, value) => Math.abs(value - target) < Math.abs(best - target) ? value : best, choices[0]);
  const pixels = metres / metresPerPixel;
  ctx.fillStyle = 'rgba(16, 21, 16, .88)';
  ctx.fillRect(width - pixels - 34, height - 48, pixels + 20, 30);
  ctx.strokeStyle = 'rgba(216, 255, 98, .7)';
  ctx.beginPath();
  ctx.moveTo(width - pixels - 20, height - 22);
  ctx.lineTo(width - 20, height - 22);
  ctx.moveTo(width - pixels - 20, height - 27);
  ctx.lineTo(width - pixels - 20, height - 17);
  ctx.moveTo(width - 20, height - 27);
  ctx.lineTo(width - 20, height - 17);
  ctx.stroke();
  ctx.fillStyle = 'rgba(221, 235, 212, .75)';
  ctx.fillText(metres >= 1000 ? `${metres / 1000} km` : `${metres} m`, width - pixels - 18, height - 26);
  ctx.restore();
}

function drawFiltered(): void {
  if (!ctx) return;
  const selected = props.breaks.find(group => group.id === props.selectedId);
  const links = props.showFiltered ? props.filteredLinks : [];
  const drawLink = (from: { lon: number; lat: number }, to: { lon: number; lat: number }, color: string, width: number) => {
    const a = screenOf(from);
    const b = screenOf(to);
    ctx!.save();
    // A dark underlay is much cheaper than per-link canvas shadows and keeps
    // dashed links readable over both street and satellite tiles.
    ctx!.setLineDash([7, 4]);
    ctx!.strokeStyle = 'rgba(0, 0, 0, .8)';
    ctx!.lineWidth = width + 2;
    ctx!.beginPath();
    ctx!.moveTo(a.x, a.y);
    ctx!.lineTo(b.x, b.y);
    ctx!.stroke();
    ctx!.strokeStyle = color;
    ctx!.lineWidth = width;
    ctx!.beginPath();
    ctx!.moveTo(a.x, a.y);
    ctx!.lineTo(b.x, b.y);
    ctx!.stroke();
    ctx!.setLineDash([]);
    ctx!.fillStyle = '#020604';
    ctx!.beginPath();
    ctx!.arc(b.x, b.y, width + 2.1, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.fillStyle = color;
    ctx!.beginPath();
    ctx!.arc(b.x, b.y, width + 1.1, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.restore();
  };
  for (const link of links) {
    const color = link.reason.includes('属性冲突') ? '#ff2bd6'
      : link.reason.includes('间隙') ? '#ffa000'
        : link.reason.includes('内部顶点') ? '#ff2020'
          : '#ffe000';
    drawLink(link.from, link.to, color, 1.6);
  }
  if (selected) {
    for (const candidate of selected.candidates) {
      drawLink({ lon: selected.lon, lat: selected.lat }, candidate.to, '#ff2020', 2.3);
    }
    if (selected.nearest) {
      ctx.save();
      const a = screenOf({ lon: selected.lon, lat: selected.lat });
      const b = screenOf({ lon: selected.nearest.lon, lat: selected.nearest.lat });
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = 'rgba(0, 0, 0, .8)';
      ctx.lineWidth = 3.7;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.7;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawStations(): void {
  if (!ctx || !props.showStations || !props.stations.length) return;
  const zoom = tileZoomForScale(view.value.scale, provider.value.minZoom, provider.value.maxZoom);
  if (zoom < STATION_MIN_TILE_ZOOM) return;
  const { width, height } = size.value;
  const viewValue = view.value;
  const scale = viewValue.scale;
  const offsetX = width / 2 - viewValue.cx * scale;
  const offsetY = height / 2 - viewValue.cy * scale;
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  const ordered = positionedStations.value;
  ctx.save();
  ctx.font = '600 10px "Noto Sans SC", system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const item of ordered) {
    const x = item.world.x * scale + offsetX;
    const y = item.world.y * scale + offsetY;
    if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;

    // Station marker is deliberately distinct from the circular break markers.
    ctx.beginPath();
    ctx.arc(x, y, 3.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#050a06';
    ctx.stroke();

    const label = stationLabel(item.station.name);
    if (!label) continue;
    const textWidth = ctx.measureText(label).width;
    const labelWidth = textWidth + 12;
    const labelHeight = 18;
    const candidates = [
      { x: x + 7, y: y - labelHeight / 2 },
      { x: x - labelWidth - 7, y: y - labelHeight / 2 },
      { x: x - labelWidth / 2, y: y - labelHeight - 7 },
      { x: x - labelWidth / 2, y: y + 7 },
    ];
    let chosen: { x: number; y: number } | undefined;
    for (const candidate of candidates) {
      if (candidate.x < 4 || candidate.y < 4 || candidate.x + labelWidth > width - 4 || candidate.y + labelHeight > height - 4) continue;
      const overlaps = boxes.some(box => candidate.x < box.x + box.w && candidate.x + labelWidth > box.x &&
        candidate.y < box.y + box.h && candidate.y + labelHeight > box.y);
      if (!overlaps) { chosen = candidate; break; }
    }
    if (!chosen) continue;
    ctx.fillStyle = 'rgba(2, 8, 4, .94)';
    ctx.fillRect(chosen.x, chosen.y, labelWidth, labelHeight);
    ctx.strokeStyle = '#d8ff62';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(chosen.x + 0.6, chosen.y + 0.6, labelWidth - 1.2, labelHeight - 1.2);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, chosen.x + 6, chosen.y + labelHeight / 2 + 0.5);
    boxes.push({ x: chosen.x, y: chosen.y, w: labelWidth, h: labelHeight });
  }
  ctx.restore();
}

const breakBaseRadius: Record<BreakGroup['kind'], number> = {
  filtered: 5.6,
  nearby: 5,
  isolated: 3.8,
};

function breakFill(kind: BreakGroup['kind']): string {
  if (kind === 'filtered') return '#ff1e1e';
  if (kind === 'nearby') return '#ff9f00';
  return '#78837d';
}

interface MarkerSprite {
  canvas: HTMLCanvasElement;
  size: number;
}

/**
 * Markers are pre-rendered once per kind/state. Drawing 1,700+ rings and text
 * labels with canvas shadows on every pointer move was the main redraw cost.
 */
const markerSprites = new Map<string, MarkerSprite>();

function markerSprite(kind: BreakGroup['kind'], selected: boolean, symbol: string, ratio: number): MarkerSprite {
  const key = `${kind}:${selected ? 'selected' : 'base'}:${symbol}:${ratio}`;
  const cached = markerSprites.get(key);
  if (cached) return cached;
  const baseRadius = breakBaseRadius[kind];
  const radius = selected ? baseRadius + 3 : baseRadius;
  const outer = radius + 2.4;
  const size = Math.ceil(outer * 2 + 2);
  const sprite = document.createElement('canvas');
  sprite.width = Math.ceil(size * ratio);
  sprite.height = Math.ceil(size * ratio);
  const spriteContext = sprite.getContext('2d');
  if (spriteContext) {
    spriteContext.scale(ratio, ratio);
    const centre = size / 2;
    spriteContext.beginPath();
    spriteContext.arc(centre, centre, outer, 0, Math.PI * 2);
    spriteContext.fillStyle = '#030604';
    spriteContext.fill();
    spriteContext.beginPath();
    spriteContext.arc(centre, centre, radius + 1.2, 0, Math.PI * 2);
    spriteContext.fillStyle = '#ffffff';
    spriteContext.fill();
    spriteContext.beginPath();
    spriteContext.arc(centre, centre, radius, 0, Math.PI * 2);
    spriteContext.fillStyle = selected ? '#f2ff00' : breakFill(kind);
    spriteContext.fill();
    if (symbol) {
      spriteContext.fillStyle = selected || kind !== 'isolated' ? '#080b08' : '#ffffff';
      spriteContext.font = '800 8.5px system-ui, sans-serif';
      spriteContext.textAlign = 'center';
      spriteContext.textBaseline = 'middle';
      spriteContext.fillText(symbol, centre, centre + 0.5);
    }
  }
  const entry = { canvas: sprite, size };
  markerSprites.set(key, entry);
  return entry;
}

function drawBreaks(): void {
  if (!ctx) return;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const viewValue = view.value;
  const { width, height } = size.value;
  const scale = viewValue.scale;
  const offsetX = width / 2 - viewValue.cx * scale;
  const offsetY = height / 2 - viewValue.cy * scale;
  const selectedId = props.selectedId;
  const baseSprites = new Map<string, MarkerSprite>();
  const selectedSprites = new Map<string, MarkerSprite>();
  for (const kind of ['filtered', 'nearby', 'isolated'] as const) {
    for (const symbol of ['!', '?', '']) {
      baseSprites.set(`${kind}:${symbol}`, markerSprite(kind, false, symbol, ratio));
      selectedSprites.set(`${kind}:${symbol}`, markerSprite(kind, true, symbol, ratio));
    }
  }
  for (const { group, world } of positionedBreaks.value) {
    const x = world.x * scale + offsetX;
    const y = world.y * scale + offsetY;
    if (x < -20 || y < -20 || x > width + 20 || y > height + 20) continue;
    const selected = group.id === selectedId;
    const symbol = group.kind === 'isolated' && !selected ? '' : group.candidates.length ? '!' : '?';
    const sprite = (selected ? selectedSprites : baseSprites).get(`${group.kind}:${symbol}`);
    if (!sprite) continue;
    ctx.drawImage(sprite.canvas, x - sprite.size / 2, y - sprite.size / 2, sprite.size, sprite.size);
    if (selected) {
      const radius = breakBaseRadius[group.kind] + 3 + 8.5;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(0, 0, 0, .9)';
      ctx.lineWidth = 4;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = '#f2ff00';
      ctx.lineWidth = 2.2;
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/** Hover feedback lives on a transparent overlay; pointer movement never redraws the main map. */
function drawHoverOverlay(): void {
  if (!hoverCtx) return;
  hoverCtx.clearRect(0, 0, size.value.width, size.value.height);
  const id = hoverId.value;
  if (!id) return;
  const item = positionedBreaks.value.find(entry => entry.group.id === id);
  if (!item) return;
  const point = screenOfWorld(item.world);
  const selected = item.group.id === props.selectedId;
  const radius = breakBaseRadius[item.group.kind] + (selected ? 3 : 0) + 5.5;
  hoverCtx.beginPath();
  hoverCtx.strokeStyle = 'rgba(0, 0, 0, .9)';
  hoverCtx.lineWidth = 4;
  hoverCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  hoverCtx.stroke();
  hoverCtx.beginPath();
  hoverCtx.strokeStyle = selected ? '#f2ff00' : '#ffffff';
  hoverCtx.lineWidth = 2;
  hoverCtx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  hoverCtx.stroke();
}

function draw(): void {
  if (!ctx) return;
  const { width, height } = size.value;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#111712');
  gradient.addColorStop(0.55, '#0d130f');
  gradient.addColorStop(1, '#101811');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  if (props.segments.length) drawBasemap();
  drawGrid();
  if (!props.segments.length) {
    ctx.fillStyle = 'rgba(221, 235, 212, .45)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('选择省份后加载线路与断点', width / 2, height / 2);
    drawHoverOverlay();
    return;
  }
  if (props.contextSegments.length) linePath(contextPath, 'rgba(196, 210, 186, .5)', 1.15);
  // Dark casing keeps the bright core readable on both light streets and dark imagery.
  linePath(allPath, 'rgba(0, 0, 0, .86)', 4.2);
  if (props.showBridgeTunnel) {
    linePath(groundPath, '#d8ff3f', 1.9);
    linePath(bridgePath, '#00e5ff', 2.6);
    linePath(tunnelPath, '#d37bff', 2.6);
  } else {
    linePath(allPath, '#d8ff3f', 1.9);
  }
  drawFiltered();
  drawStations();
  drawBreaks();
  drawHoverOverlay();
}

function findBreakAt(x: number, y: number): BreakGroup | undefined {
  let best: BreakGroup | undefined;
  let bestDistance = 13;
  const viewValue = view.value;
  const { width, height } = size.value;
  const scale = viewValue.scale;
  const offsetX = width / 2 - viewValue.cx * scale;
  const offsetY = height / 2 - viewValue.cy * scale;
  for (const { group, world } of positionedBreaks.value) {
    const distance = Math.hypot(world.x * scale + offsetX - x, world.y * scale + offsetY - y);
    if (distance <= bestDistance) {
      best = group;
      bestDistance = distance;
    }
  }
  return best;
}

function localPoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0) return;
  const point = localPoint(event);
  dragging = true;
  dragDistance = 0;
  pointerDownId = event.pointerId;
  dragStart = point;
  dragCentre = { x: view.value.cx, y: view.value.cy };
  canvas.value?.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  const geo = wgs84At(point.x, point.y);
  cursor.value = geo;
  emit('cursor', geo.lon, geo.lat);
  if (dragging) {
    dragDistance = Math.max(dragDistance, Math.hypot(point.x - dragStart.x, point.y - dragStart.y));
    view.value = {
      ...view.value,
      cx: dragCentre.x - (point.x - dragStart.x) / view.value.scale,
      cy: dragCentre.y - (point.y - dragStart.y) / view.value.scale,
    };
    hoverId.value = null;
    drawHoverOverlay();
    requestRender();
    return;
  }
  const hit = findBreakAt(point.x, point.y);
  const nextHover = hit?.id ?? null;
  if (nextHover !== hoverId.value) {
    hoverId.value = nextHover;
    drawHoverOverlay();
  }
  tooltip.value = { x: point.x, y: point.y };
  if (canvas.value) canvas.value.style.cursor = hit ? 'pointer' : 'grab';
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging) return;
  const point = localPoint(event);
  dragging = false;
  if (pointerDownId !== null && canvas.value?.hasPointerCapture(pointerDownId)) canvas.value.releasePointerCapture(pointerDownId);
  pointerDownId = null;
  if (dragDistance <= 4) {
    const hit = findBreakAt(point.x, point.y);
    emit('select', hit?.id ?? null);
  }
}

function onPointerCancel(): void {
  dragging = false;
  pointerDownId = null;
  hoverId.value = null;
  drawHoverOverlay();
}

function onPointerLeave(): void {
  cursor.value = null;
  hoverId.value = null;
  emit('cursor', null, null);
  drawHoverOverlay();
}

function onWheel(event: WheelEvent): void {
  const point = localPoint(event);
  zoomBy(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
}

watch(() => [props.segments, props.contextSegments], () => {
  rebuildPaths();
  fit();
}, { flush: 'post' });
watch(() => [props.breaks, props.filteredLinks, props.selectedId, props.showFiltered, props.showBridgeTunnel, props.showIsolated, props.stations, props.showStations], requestRender);
watch(() => props.basemap, () => {
  tileState.value = 'loading';
  requestRender();
});
watch(() => props.selectedId, () => { hoverId.value = null; requestRender(); });

onMounted(() => {
  resizeObserver = new ResizeObserver(() => resize());
  if (host.value) resizeObserver.observe(host.value);
  resize();
  rebuildPaths();
  fit();
  window.addEventListener('resize', resize);
});

onBeforeUnmount(() => {
  disposed = true;
  resizeObserver?.disconnect();
  cancelAnimationFrame(renderFrame);
  window.removeEventListener('resize', resize);
});

defineExpose({ fit, focus, zoomIn, zoomOut });
</script>

<template>
  <div ref="host" class="railway-map">
    <canvas ref="canvas" aria-label="高德底图线路检查地图" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @pointerleave="onPointerLeave" @wheel.prevent="onWheel" />
    <canvas ref="hoverCanvas" class="hover-canvas" aria-hidden="true" />
    <div v-if="hovered" class="map-tooltip" :style="{ left: `${tooltip.x + 14}px`, top: `${tooltip.y + 14}px` }">
      <strong>{{ hovered.title }}</strong>
      <span>{{ hovered.kind === 'filtered' ? '存在被过滤连接' : hovered.kind === 'nearby' ? '邻近线路未接入' : '孤立端点' }} · {{ hovered.approaches.length }} 条来路</span>
    </div>
    <div class="map-controls" role="group" aria-label="地图缩放">
      <button title="放大" @click="zoomIn">＋</button>
      <button title="缩小" @click="zoomOut">−</button>
      <button title="适合省域" @click="fit">⤢</button>
    </div>
    <div v-if="basemapNotice" class="map-basemap-status">{{ basemapNotice }}</div>
    <div class="map-cursor">{{ cursor ? `WGS84 ${cursor.lon.toFixed(5)}, ${cursor.lat.toFixed(5)}` : '拖拽平移 · 滚轮缩放 · 点击断点查看详情' }}</div>
  </div>
</template>

<style scoped>
.railway-map { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0d130f; }
canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
canvas:active { cursor: grabbing; }
.hover-canvas { position: absolute; inset: 0; z-index: 1; pointer-events: none; cursor: inherit; }
.map-tooltip { position: absolute; z-index: 3; max-width: min(320px, 70vw); padding: 8px 10px; border: 1px solid rgba(216, 255, 98, .45); background: rgba(12, 18, 13, .94); box-shadow: 0 8px 24px #0008; pointer-events: none; }
.map-tooltip strong { display: block; color: #eff5e7; font-size: 11px; }
.map-tooltip span { display: block; margin-top: 3px; color: #9aa695; font-size: 9px; }
.map-controls { position: absolute; z-index: 3; top: 14px; right: 14px; display: flex; flex-direction: column; gap: 4px; }
.map-controls button { width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.18); background: rgba(14, 20, 15, .9); color: #d8ff62; font-size: 15px; }
.map-controls button:hover { border-color: #d8ff62; }
.map-basemap-status { position: absolute; z-index: 3; left: 50%; bottom: 14px; max-width: 60%; padding: 5px 8px; border: 1px solid rgba(255, 179, 71, .35); background: rgba(24, 18, 10, .9); color: #ffcc8a; font-size: 9px; transform: translateX(-50%); pointer-events: none; }
.map-cursor { position: absolute; z-index: 3; left: 14px; bottom: 14px; padding: 5px 8px; border: 1px solid rgba(255,255,255,.12); background: rgba(12, 18, 13, .82); color: #a9b7a3; font-family: ui-monospace, monospace; font-size: 9px; pointer-events: none; }
</style>
