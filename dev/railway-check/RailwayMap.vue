<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { RailSegment } from '../../src/types';
import { BASEMAPS, type BasemapId } from './basemap';
import type { BreakGroup, FilteredLink } from './analysis';
import { metresPerWorldUnit, projectMercator, tileZoomForScale, unprojectMercator } from './mercator';

const props = defineProps<{
  segments: RailSegment[];
  contextSegments: RailSegment[];
  breaks: BreakGroup[];
  filteredLinks: FilteredLink[];
  selectedId: string | null;
  showFiltered: boolean;
  showBridgeTunnel: boolean;
  showIsolated: boolean;
  basemap: BasemapId;
}>();
const emit = defineEmits<{ select: [id: string | null]; cursor: [lon: number | null, lat: number | null] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const view = ref({ cx: 0, cy: 0, scale: 1 });
const size = ref({ width: 0, height: 0 });
const hoverId = ref<string | null>(null);
const tooltip = ref({ x: 0, y: 0 });
const cursor = ref<{ lon: number; lat: number } | null>(null);
const basemapNotice = ref('');

let ctx: CanvasRenderingContext2D | null = null;
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

interface TileEntry {
  image: HTMLImageElement;
  state: 'loading' | 'ready' | 'error';
}
const tileCache = new Map<string, TileEntry>();
let tileFailureCount = 0;

const visibleBreaks = computed(() => props.breaks.filter(group => props.showIsolated || group.kind !== 'isolated' || group.id === props.selectedId));
const hovered = computed(() => visibleBreaks.value.find(group => group.id === hoverId.value));

function project(lon: number, lat: number): { x: number; y: number } {
  return projectMercator(lon, lat);
}

function screenOf(lon: number, lat: number): { x: number; y: number } {
  const point = project(lon, lat);
  return {
    x: size.value.width / 2 + (point.x - view.value.cx) * view.value.scale,
    y: size.value.height / 2 + (point.y - view.value.cy) * view.value.scale,
  };
}

function worldAt(x: number, y: number): { x: number; y: number } {
  return {
    x: view.value.cx + (x - size.value.width / 2) / view.value.scale,
    y: view.value.cy + (y - size.value.height / 2) / view.value.scale,
  };
}

function lonLatAt(x: number, y: number): { lon: number; lat: number } {
  const point = worldAt(x, y);
  return unprojectMercator(point.x, point.y);
}

function addSegment(path: Path2D, segment: RailSegment): void {
  segment.points.forEach((point, index) => {
    const projected = project(point.lon, point.lat);
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
      const projected = project(point.lon, point.lat);
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
  const point = project(lon, lat);
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
  if (!ctx || props.basemap === 'none') return;
  const provider = BASEMAPS[props.basemap];
  const { width, height } = size.value;
  const zoom = tileZoomForScale(view.value.scale, provider.minZoom, provider.maxZoom);
  const tilesPerSide = 2 ** zoom;
  const tileWorld = 1 / tilesPerSide;
  const tileScreen = tileWorld * view.value.scale;
  const left = view.value.cx - (width / 2) / view.value.scale;
  const right = view.value.cx + (width / 2) / view.value.scale;
  const top = view.value.cy - (height / 2) / view.value.scale;
  const bottom = view.value.cy + (height / 2) / view.value.scale;
  const firstX = Math.max(0, Math.floor(left / tileWorld));
  const lastX = Math.min(tilesPerSide - 1, Math.ceil(right / tileWorld) - 1);
  const firstY = Math.max(0, Math.floor(top / tileWorld));
  const lastY = Math.min(tilesPerSide - 1, Math.ceil(bottom / tileWorld) - 1);
  let ready = 0;
  let failed = 0;

  for (let y = firstY; y <= lastY; y++) {
    for (let x = firstX; x <= lastX; x++) {
      const key = `${provider.id}/${zoom}/${x}/${y}`;
      let entry = tileCache.get(key);
      if (!entry) {
        const image = new Image();
        const created: TileEntry = { image, state: 'loading' };
        const providerId = provider.id;
        entry = created;
        tileCache.set(key, created);
        image.onload = () => {
          created.state = 'ready';
          if (props.basemap === providerId) {
            tileFailureCount = 0;
            basemapNotice.value = '';
          }
          requestRender();
        };
        image.onerror = () => {
          created.state = 'error';
          if (props.basemap === providerId) {
            tileFailureCount++;
            if (tileFailureCount >= 3) basemapNotice.value = '底图瓦片加载失败；线路与断点仍按 WGS84 显示';
          }
          requestRender();
        };
        image.src = provider.tileUrl(zoom, x, y);
      }
      if (entry.state === 'ready') ready++;
      else if (entry.state === 'error') failed++;
      if (entry.state !== 'ready') continue;
      const sx = width / 2 + (x * tileWorld - view.value.cx) * view.value.scale;
      const sy = height / 2 + (y * tileWorld - view.value.cy) * view.value.scale;
      ctx.drawImage(entry.image, sx, sy, tileScreen + 0.6, tileScreen + 0.6);
    }
  }
  if (ready === 0 && failed > 0) basemapNotice.value = '底图瓦片加载失败；线路与断点仍按 WGS84 显示';
  if (tileCache.size > 480) {
    for (const [key, entry] of tileCache) {
      if (entry.state !== 'loading') tileCache.delete(key);
      if (tileCache.size <= 360) break;
    }
  }
  if (ready > 0) {
    // Keep the street layer subdued; satellite also gets a light scrim so bright
    // terrain does not swallow the rail overlay.
    ctx.fillStyle = props.basemap === 'satellite' ? 'rgba(5, 11, 8, .28)' : 'rgba(7, 12, 9, .42)';
    ctx.fillRect(0, 0, width, height);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const text = provider.attribution;
    const textWidth = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(10, 15, 11, .72)';
    ctx.fillRect(width - textWidth - 14, height - 64, textWidth + 8, 14);
    ctx.fillStyle = 'rgba(229, 238, 224, .72)';
    ctx.fillText(text, width - textWidth - 10, height - 53);
  }
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
  const topLeft = lonLatAt(0, 0);
  const bottomRight = lonLatAt(width, height);
  const west = Math.min(topLeft.lon, bottomRight.lon);
  const east = Math.max(topLeft.lon, bottomRight.lon);
  const north = Math.max(topLeft.lat, bottomRight.lat);
  const south = Math.min(topLeft.lat, bottomRight.lat);
  const span = Math.max(east - west, north - south);
  const step = niceStep(span / 8);
  const hasBasemap = props.basemap !== 'none';
  ctx.save();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = hasBasemap ? 'rgba(240, 247, 234, .78)' : 'rgba(221, 235, 212, .4)';
  ctx.strokeStyle = hasBasemap ? 'rgba(216, 255, 98, .14)' : 'rgba(216, 255, 98, .07)';
  ctx.lineWidth = 1;
  const startLon = Math.ceil(west / step) * step;
  const startLat = Math.ceil(south / step) * step;
  for (let lon = startLon; lon <= east + step * 0.001; lon += step) {
    const { x } = screenOf(lon, north);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    const label = Math.abs(step) < 0.01 ? lon.toFixed(4) : Math.abs(step) < 0.1 ? lon.toFixed(3) : lon.toFixed(2);
    ctx.fillText(`${label}°E`, x + 4, height - 10);
  }
  for (let lat = startLat; lat <= north + step * 0.001; lat += step) {
    const { y } = screenOf(west, lat);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
    const label = Math.abs(step) < 0.01 ? lat.toFixed(4) : Math.abs(step) < 0.1 ? lat.toFixed(3) : lat.toFixed(2);
    ctx.fillText(`${label}°N`, 8, y - 4);
  }
  // Scale bar in metres at the map centre; Web Mercator scale varies with latitude.
  const centre = lonLatAt(width / 2, height / 2);
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
    const a = screenOf(from.lon, from.lat);
    const b = screenOf(to.lon, to.lat);
    ctx!.save();
    ctx!.strokeStyle = color;
    ctx!.lineWidth = width;
    ctx!.setLineDash([6, 4]);
    ctx!.beginPath();
    ctx!.moveTo(a.x, a.y);
    ctx!.lineTo(b.x, b.y);
    ctx!.stroke();
    ctx!.setLineDash([]);
    ctx!.fillStyle = color;
    ctx!.beginPath();
    ctx!.arc(b.x, b.y, width + 0.6, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.restore();
  };
  for (const link of links) {
    const color = link.reason.includes('属性冲突') ? '#ff4fd8'
      : link.reason.includes('间隙') ? '#ffad4d'
        : link.reason.includes('内部顶点') ? '#ff5a4e'
          : '#ffd166';
    drawLink(link.from, link.to, color, 1.2);
  }
  if (selected) {
    for (const candidate of selected.candidates) {
      drawLink({ lon: selected.lon, lat: selected.lat }, candidate.to, '#ff5a4e', 1.8);
    }
    if (selected.nearest) {
      ctx.save();
      ctx.strokeStyle = 'rgba(111, 214, 232, .8)';
      ctx.lineWidth = 1.1;
      ctx.setLineDash([3, 4]);
      const a = screenOf(selected.lon, selected.lat);
      const b = screenOf(selected.nearest.lon, selected.nearest.lat);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function breakColor(group: BreakGroup): string {
  if (group.id === props.selectedId) return '#d8ff62';
  if (group.kind === 'filtered') return '#ff5a4e';
  if (group.kind === 'nearby') return '#ffb347';
  return '#899287';
}

function drawBreaks(): void {
  if (!ctx) return;
  const groups = visibleBreaks.value;
  // Draw low-priority isolated points first, then the actionable breaks on top.
  for (const group of groups) {
    const point = screenOf(group.lon, group.lat);
    if (point.x < -20 || point.y < -20 || point.x > size.value.width + 20 || point.y > size.value.height + 20) continue;
    const selected = group.id === props.selectedId;
    const hoveredNow = group.id === hoverId.value;
    const radius = group.kind === 'filtered' ? 5 : group.kind === 'nearby' ? 4.5 : 3;
    ctx.beginPath();
    ctx.fillStyle = breakColor(group);
    ctx.globalAlpha = group.kind === 'isolated' && !selected ? 0.58 : 1;
    ctx.arc(point.x, point.y, selected ? radius + 3 : hoveredNow ? radius + 2 : radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#0d110d';
    ctx.stroke();
    if (selected || hoveredNow) {
      ctx.beginPath();
      ctx.strokeStyle = selected ? '#d8ff62' : 'rgba(255,255,255,.7)';
      ctx.lineWidth = 1.5;
      ctx.arc(point.x, point.y, (selected ? radius + 8 : radius + 5), 0, Math.PI * 2);
      ctx.stroke();
    }
    if (group.kind !== 'isolated' || selected) {
      ctx.fillStyle = '#0d110d';
      ctx.font = '700 8px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(group.candidates.length ? '!' : '?', point.x, point.y + 0.5);
    }
  }
}

function draw(): void {
  if (!ctx) return;
  const { width, height } = size.value;
  ctx.setTransform(Math.min(2, window.devicePixelRatio || 1), 0, 0, Math.min(2, window.devicePixelRatio || 1), 0, 0);
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
    return;
  }
  if (props.contextSegments.length) linePath(contextPath, 'rgba(122, 139, 117, .4)', 1);
  if (props.showBridgeTunnel) {
    linePath(groundPath, '#9aa690', 1.35);
    linePath(bridgePath, '#58d6e8', 2.1);
    linePath(tunnelPath, '#b08cff', 2.1);
  } else {
    linePath(allPath, '#9aa690', 1.35);
  }
  drawFiltered();
  drawBreaks();
}

function findBreakAt(x: number, y: number): BreakGroup | undefined {
  let best: BreakGroup | undefined;
  let bestDistance = 13;
  for (const group of visibleBreaks.value) {
    const point = screenOf(group.lon, group.lat);
    const distance = Math.hypot(point.x - x, point.y - y);
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
  const geo = lonLatAt(point.x, point.y);
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
    requestRender();
    return;
  }
  const hit = findBreakAt(point.x, point.y);
  hoverId.value = hit?.id ?? null;
  tooltip.value = { x: point.x, y: point.y };
  if (canvas.value) canvas.value.style.cursor = hit ? 'pointer' : 'grab';
  requestRender();
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
}

function onPointerLeave(): void {
  cursor.value = null;
  hoverId.value = null;
  emit('cursor', null, null);
  requestRender();
}

function onWheel(event: WheelEvent): void {
  const point = localPoint(event);
  zoomBy(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
}

watch(() => [props.segments, props.contextSegments], () => {
  rebuildPaths();
  fit();
}, { flush: 'post' });
watch(() => [props.breaks, props.filteredLinks, props.selectedId, props.showFiltered, props.showBridgeTunnel, props.showIsolated], requestRender);
watch(() => props.basemap, () => {
  basemapNotice.value = '';
  tileFailureCount = 0;
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
    <canvas ref="canvas" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @pointerleave="onPointerLeave" @wheel.prevent="onWheel" />
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
    <div class="map-cursor">{{ cursor ? `${cursor.lon.toFixed(5)}, ${cursor.lat.toFixed(5)}` : '拖拽平移 · 滚轮缩放 · 点击断点查看详情' }}</div>
  </div>
</template>

<style scoped>
.railway-map { position: relative; width: 100%; height: 100%; overflow: hidden; background: #0d130f; }
canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
canvas:active { cursor: grabbing; }
.map-tooltip { position: absolute; z-index: 3; max-width: min(320px, 70vw); padding: 8px 10px; border: 1px solid rgba(216, 255, 98, .45); background: rgba(12, 18, 13, .94); box-shadow: 0 8px 24px #0008; pointer-events: none; }
.map-tooltip strong { display: block; color: #eff5e7; font-size: 11px; }
.map-tooltip span { display: block; margin-top: 3px; color: #9aa695; font-size: 9px; }
.map-controls { position: absolute; top: 14px; right: 14px; display: flex; flex-direction: column; gap: 4px; }
.map-controls button { width: 32px; height: 32px; border: 1px solid rgba(255,255,255,.18); background: rgba(14, 20, 15, .9); color: #d8ff62; font-size: 15px; }
.map-controls button:hover { border-color: #d8ff62; }
.map-basemap-status { position: absolute; left: 50%; bottom: 14px; max-width: 60%; padding: 5px 8px; border: 1px solid rgba(255, 179, 71, .35); background: rgba(24, 18, 10, .9); color: #ffcc8a; font-size: 9px; transform: translateX(-50%); pointer-events: none; }
.map-cursor { position: absolute; left: 14px; bottom: 14px; padding: 5px 8px; border: 1px solid rgba(255,255,255,.12); background: rgba(12, 18, 13, .82); color: #8e9b88; font-family: ui-monospace, monospace; font-size: 9px; pointer-events: none; }
</style>
