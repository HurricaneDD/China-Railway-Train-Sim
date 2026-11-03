<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StationDeparture } from '../types';
import { BASEMAPS } from '../map/basemap';
import { BasemapTiles, drawMapBackground, drawNorthArrow, drawScaleBar } from '../map/canvasLayer';
import { closestScreenPath, fitLonLatPaths, panViewBy, pointAtPathFraction, screenOf, zoomViewAt, type MapView, type ScreenPath, type ScreenPoint } from '../map/junctionMap';
import { unprojectMercator } from '../utils/mercator';

const props = defineProps<{ departure: StationDeparture; selected?: string; direction: 1 | -1 | 0 }>();
const emit = defineEmits<{ select: [segmentId: string] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const basemap = ref<'satellite' | 'plain'>('satellite');
const hoverId = ref<string>();
const tileState = ref<'loading' | 'ready' | 'error'>('loading');
const size = ref({ width: 0, height: 0 });

let ctx: CanvasRenderingContext2D | null = null;
let view: MapView | undefined;
let baseScale = 1;
let resizeObserver: ResizeObserver | undefined;
let renderFrame = 0;
let disposed = false;
let hitPaths: ScreenPath[] = [];
let drag: { x: number; y: number; start: MapView; moved: boolean } | undefined;
const tiles = new BasemapTiles();

const provider = computed(() => BASEMAPS[basemap.value]);
const hoveredLine = computed(() => props.departure.lines.find(line => line.segmentId === hoverId.value));
const basemapNotice = computed(() => tileState.value === 'loading' ? '底图加载中…' : tileState.value === 'error' ? '底图加载失败，线路仍按 WGS84 显示' : '');

function requestRender(): void {
  if (disposed || renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    draw();
  });
}

function screenPath(id: string, points: { lon: number; lat: number }[]): ScreenPath {
  return { id, points: view ? points.map(point => screenOf(point, view!, size.value.width, size.value.height)) : [] };
}

function resetView(): void {
  if (!size.value.width || !size.value.height) return;
  const fitted = fitLonLatPaths([
    ...props.departure.lines.map(line => line.points),
    [{ lon: props.departure.center.lon, lat: props.departure.center.lat }],
  ], size.value.width, size.value.height, 48, 420);
  if (!fitted) return;
  baseScale = fitted.scale;
  view = fitted;
  requestRender();
}

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
  if (!view) resetView(); else requestRender();
}

function setBasemap(next: 'satellite' | 'plain'): void {
  if (basemap.value === next) return;
  basemap.value = next;
  tileState.value = 'loading';
  requestRender();
}

function zoomAt(x: number, y: number, factor: number): void {
  if (!view) return;
  view = zoomViewAt(view, size.value.width, size.value.height, x, y, factor, baseScale * 0.4, baseScale * 35);
  requestRender();
}

function onWheel(event: WheelEvent): void {
  const rect = canvas.value?.getBoundingClientRect();
  if (!rect) return;
  const factor = Math.max(0.5, Math.min(2, Math.exp(-event.deltaY * 0.0015)));
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
}

function zoomButton(factor: number): void {
  zoomAt(size.value.width / 2, size.value.height / 2, factor);
}

function drawBasemap(): void {
  if (!ctx || !view) return;
  const status = tiles.draw(ctx, view, size.value.width, size.value.height, provider.value, requestRender);
  if (status !== 'ready') {
    if (tileState.value !== status) tileState.value = status;
    return;
  }
  if (tileState.value !== 'ready') tileState.value = 'ready';
  const { width, height } = size.value;
  ctx.fillStyle = basemap.value === 'satellite' ? 'rgba(4, 10, 7, .32)' : 'rgba(5, 10, 7, .16)';
  ctx.fillRect(0, 0, width, height);
}

function strokePath(points: ScreenPoint[], color: string, width: number): void {
  if (!ctx || points.length < 2) return;
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx!.lineTo(point.x, point.y) : ctx!.moveTo(point.x, point.y));
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function arrowAngle(path: ScreenPath, fraction: number): number {
  const behind = pointAtPathFraction(path, Math.max(0, fraction - 0.012));
  const ahead = pointAtPathFraction(path, Math.min(1, fraction + 0.012));
  return Math.atan2(ahead.y - behind.y, ahead.x - behind.x);
}

function drawArrow(path: ScreenPath, fraction: number, color: string, size: number): void {
  if (!ctx || path.points.length < 2) return;
  const point = pointAtPathFraction(path, fraction);
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.rotate(arrowAngle(path, fraction));
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.62, size * 0.72);
  ctx.lineTo(-size * 0.62, -size * 0.72);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#07100a';
  ctx.lineWidth = 1.1;
  ctx.stroke();
  ctx.restore();
}

function drawStation(): void {
  if (!ctx || !view) return;
  const node = screenOf(props.departure.center, view, size.value.width, size.value.height);
  ctx.save();
  ctx.shadowColor = 'rgba(255, 255, 255, .55)';
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(node.x, node.y, 7.5, 0, Math.PI * 2);
  ctx.fillStyle = '#f4f8ee';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#0b120c';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(node.x, node.y, 2.4, 0, Math.PI * 2);
  ctx.fillStyle = '#d8ff62';
  ctx.fill();

  const label = '车站';
  ctx.font = '600 10px "Noto Sans SC", system-ui, sans-serif';
  const width = ctx.measureText(label).width + 14;
  const x = Math.max(8, Math.min(size.value.width - width - 8, node.x + 13));
  const y = Math.max(8, Math.min(size.value.height - 26, node.y - 29));
  ctx.fillStyle = 'rgba(9, 15, 10, .9)';
  ctx.fillRect(x, y, width, 20);
  ctx.strokeStyle = 'rgba(216, 255, 98, .55)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, 19);
  ctx.fillStyle = '#d8ff62';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + width / 2, y + 10.5);
  ctx.restore();
}

function draw(): void {
  if (!ctx) return;
  const { width, height } = size.value;
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  hitPaths = [];
  drawMapBackground(ctx, width, height);
  drawBasemap();
  if (!view) {
    ctx.fillStyle = 'rgba(229, 237, 223, .55)';
    ctx.font = '12px "Noto Sans SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('车站附近没有可显示的线路', width / 2, height / 2);
    return;
  }

  const paths = props.departure.lines.map(line => screenPath(line.segmentId, line.points));
  hitPaths = paths;
  for (const [index, path] of paths.entries()) {
    const line = props.departure.lines[index];
    const selected = line.segmentId === props.selected;
    const hovering = line.segmentId === hoverId.value;
    if (selected) continue;
    strokePath(path.points, 'rgba(3, 9, 5, .92)', hovering ? 6 : 3.6);
    strokePath(path.points, hovering ? '#d9feff' : '#c7d3c1', hovering ? 3 : 1.35);
  }

  const selectedIndex = props.departure.lines.findIndex(line => line.segmentId === props.selected);
  const selectedPath = selectedIndex >= 0 ? paths[selectedIndex] : undefined;
  if (selectedPath) {
    const line = props.departure.lines[selectedIndex];
    ctx.save();
    ctx.shadowColor = 'rgba(216, 255, 98, .7)';
    ctx.shadowBlur = 14;
    strokePath(selectedPath.points, '#061008', 8.5);
    ctx.restore();
    strokePath(selectedPath.points, '#d8ff62', 4);
    if (props.direction !== 0) {
      const directed: ScreenPath = {
        id: line.segmentId,
        points: props.direction > 0 ? selectedPath.points : [...selectedPath.points].reverse(),
      };
      for (const fraction of [0.18, 0.42, 0.66, 0.9]) drawArrow(directed, fraction, '#d8ff62', 8);
    }
  }

  drawStation();
  drawNorthArrow(ctx);
  const center = unprojectMercator(view.cx, view.cy);
  drawScaleBar(ctx, view, width, height, center.lat);
  if (props.departure.lines.length === 0) {
    ctx.fillStyle = 'rgba(229, 237, 223, .55)';
    ctx.font = '12px "Noto Sans SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('车站附近没有可选线路', width / 2, height / 2);
  }
}

function localPoint(event: PointerEvent | WheelEvent | MouseEvent): ScreenPoint {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function findLineAt(point: ScreenPoint): string | undefined {
  return closestScreenPath(hitPaths, point.x, point.y, 14);
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !view) return;
  canvas.value?.setPointerCapture(event.pointerId);
  drag = { ...localPoint(event), start: { ...view }, moved: false };
  if (canvas.value) canvas.value.style.cursor = 'grabbing';
}

function onPointerMove(event: PointerEvent): void {
  if (drag) {
    const point = localPoint(event);
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    view = panViewBy(drag.start, dx, dy);
    requestRender();
    return;
  }
  const id = findLineAt(localPoint(event));
  if (id !== hoverId.value) {
    hoverId.value = id;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = id ? 'pointer' : 'grab';
}

function onPointerUp(event: PointerEvent): void {
  if (!drag) return;
  const point = localPoint(event);
  const wasMoved = drag.moved;
  drag = undefined;
  canvas.value?.releasePointerCapture(event.pointerId);
  if (canvas.value) canvas.value.style.cursor = 'grab';
  if (!wasMoved) {
    const id = findLineAt(point);
    if (id) emit('select', id);
  }
}

function onPointerLeave(): void {
  if (drag) return;
  if (hoverId.value) {
    hoverId.value = undefined;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = 'grab';
}

function onKeyDown(event: KeyboardEvent): void {
  if ((event.code === 'Enter' || event.code === 'Space') && hoverId.value) {
    event.preventDefault();
    emit('select', hoverId.value!);
  }
}

watch(() => props.selected, requestRender);
watch(() => props.direction, requestRender);
watch(() => props.departure.station.telecode, () => { hoverId.value = undefined; view = undefined; resetView(); });
watch(basemap, () => { tileState.value = 'loading'; requestRender(); });

onMounted(() => {
  resizeObserver = new ResizeObserver(resize);
  if (host.value) resizeObserver.observe(host.value);
  resize();
});

onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(renderFrame);
  resizeObserver?.disconnect();
});
</script>

<template>
  <div ref="host" class="station-map-host">
    <canvas ref="canvas" class="station-map-canvas" role="img" tabindex="0" aria-label="车站周边线路图。点击线路选择始发线路；滚轮缩放，拖动平移。灰色线路为车站附近国铁线路，绿色为已选线路。" @wheel.prevent="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @pointerleave="onPointerLeave" @keydown="onKeyDown" />
    <div class="station-map-toolbar" aria-label="底图选择">
      <span>底图</span>
      <button :class="{ active: basemap === 'satellite' }" :aria-pressed="basemap === 'satellite'" @click="setBasemap('satellite')">卫星</button>
      <button :class="{ active: basemap === 'plain' }" :aria-pressed="basemap === 'plain'" @click="setBasemap('plain')">普通</button>
    </div>
    <div class="station-map-zoom" aria-label="地图缩放">
      <button aria-label="放大" title="放大" @click="zoomButton(1.5)">＋</button>
      <button aria-label="缩小" title="缩小" @click="zoomButton(1 / 1.5)">−</button>
      <button aria-label="复位视图" title="复位视图" @click="resetView">⤢</button>
    </div>
    <p v-if="basemapNotice" class="station-map-notice" role="status">{{ basemapNotice }}</p>
    <p v-if="hoveredLine" class="station-map-hover">
      {{ hoveredLine.name === '未命名铁路' ? '未命名线路' : hoveredLine.name }} · 距站 {{ Math.round(hoveredLine.distance) }} m
    </p>
    <p class="station-map-hint">滚轮缩放 · 拖动平移 · 点击线路选择</p>
    <p class="station-map-attribution">{{ provider.attribution }}</p>
    <p v-if="!departure.lines.length" class="station-map-notice error">没有可选线路</p>
  </div>
</template>

<style scoped>
.station-map-host { position: relative; flex: 1; min-height: 0; overflow: hidden; border: 1px solid rgba(255,255,255,.14); background: #0b120d; }
.station-map-canvas { display: block; width: 100%; height: 100%; outline: none; cursor: grab; touch-action: none; }
.station-map-canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.station-map-toolbar { position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 3px; padding: 4px; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .84); backdrop-filter: blur(8px); }
.station-map-toolbar span { padding: 0 5px; color: #8e9b89; font-size: 9px; letter-spacing: .5px; }
.station-map-toolbar button { min-height: 25px; padding: 0 8px; border: 1px solid transparent; color: #b8c4b2; background: transparent; font-size: 9px; }
.station-map-toolbar button:hover { color: #f1f7eb; border-color: rgba(255,255,255,.22); }
.station-map-toolbar button.active { border-color: var(--accent); color: #111710; background: var(--accent); }
.station-map-zoom { position: absolute; top: 54px; right: 12px; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .84); backdrop-filter: blur(8px); }
.station-map-zoom button { width: 30px; height: 28px; border: 0; border-bottom: 1px solid rgba(255,255,255,.1); color: #dbe5d5; background: transparent; font-size: 14px; line-height: 1; }
.station-map-zoom button:last-child { border-bottom: 0; font-size: 12px; }
.station-map-zoom button:hover { color: #111710; background: var(--accent); }
.station-map-notice { position: absolute; top: 12px; left: 50%; margin: 0; padding: 5px 9px; color: #d7e5cf; background: rgba(8, 14, 9, .84); border: 1px solid rgba(255,255,255,.13); font-size: 9px; transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.station-map-notice.error { color: #ffd0c5; border-color: #714a41; }
.station-map-hover { position: absolute; top: 58px; left: 12px; max-width: min(58%, 420px); margin: 0; padding: 6px 10px; overflow: hidden; color: #eff8e8; background: rgba(8, 14, 9, .9); border: 1px solid rgba(216, 255, 98, .35); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.station-map-hint { position: absolute; bottom: 11px; left: 50%; margin: 0; padding: 4px 8px; color: rgba(229, 238, 222, .65); background: rgba(8, 14, 9, .66); font-size: 8.5px; transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.station-map-attribution { position: absolute; right: 9px; bottom: 7px; max-width: 56%; margin: 0; overflow: hidden; color: rgba(228, 238, 222, .62); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; text-align: right; pointer-events: none; }
@media (max-width: 620px) {
  .station-map-toolbar { top: 8px; right: 8px; }
  .station-map-toolbar span { display: none; }
  .station-map-zoom { top: 48px; right: 8px; }
  .station-map-notice { top: 8px; left: 8px; max-width: calc(100% - 132px); overflow: hidden; text-overflow: ellipsis; transform: none; }
  .station-map-hover { top: 88px; left: 8px; max-width: calc(100% - 60px); }
  .station-map-hint { display: none; }
  .station-map-attribution { max-width: 52%; font-size: 7px; }
}
</style>
