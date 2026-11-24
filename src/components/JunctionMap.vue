<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { JunctionRequest, LonLat } from '../types';
import { BASEMAPS, type BasemapProvider } from '../map/basemap';
import { BasemapTiles, drawMapBackground, drawNorthArrow, drawScaleBar } from '../map/canvasLayer';
import { closestScreenPath, fitLonLatPaths, panViewBy, pinchView, pointAtPathFraction, screenOf, zoomViewAt, type MapView, type ScreenPath, type ScreenPoint } from '../map/junctionMap';
import { wgs84ToGcj02, gcj02ToWgs84 } from '../utils/gcj02';
import { projectMercator, unprojectMercator } from '../utils/mercator';

const props = defineProps<{ junction: JunctionRequest; selected?: string }>();
const emit = defineEmits<{ select: [segmentId: string] }>();

type JunctionBasemap = 'amap-satellite' | 'amap-street';
const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const basemap = ref<JunctionBasemap>('amap-satellite');
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
let pinch: { distance: number; midpoint: ScreenPoint; view: MapView } | undefined;
let gestureMoved = false;
const pointers = new Map<number, ScreenPoint>();

const tiles = new BasemapTiles();

const optionCount = computed(() => props.junction.options.length);
const provider = computed(() => BASEMAPS[basemap.value]);
const hoveredOption = computed(() => props.junction.options.find(option => option.segmentId === hoverId.value));
const basemapNotice = computed(() => tileState.value === 'loading' ? '底图加载中…' : tileState.value === 'error' ? '底图加载失败，线路仍可显示' : '');
const coordinateNotice = computed(() => provider.value.coordinateSystem === 'gcj02' ? ' · GCJ-02 已配准' : '');

function requestRender(): void {
  if (disposed || renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    draw();
  });
}

/** Railway data stays WGS84; only this display copy is converted for AMap tiles. */
function displayPoint(point: LonLat): LonLat {
  return provider.value.coordinateSystem === 'gcj02' ? wgs84ToGcj02(point) : point;
}

function displayCentreOf(viewValue: MapView): LonLat {
  const centre = unprojectMercator(viewValue.cx, viewValue.cy);
  return provider.value.coordinateSystem === 'gcj02' ? gcj02ToWgs84(centre) : centre;
}

function centreForProvider(point: LonLat, target: BasemapProvider): LonLat {
  return target.coordinateSystem === 'gcj02' ? wgs84ToGcj02(point) : point;
}

function screenPath(id: string, points: LonLat[]): ScreenPath {
  return { id, points: view ? points.map(point => screenOf(displayPoint(point), view!, size.value.width, size.value.height)) : [] };
}

function fit(): void {
  if (!size.value.width || !size.value.height) return;
  const fitted = fitLonLatPaths([
    props.junction.context.incoming,
    props.junction.options.flatMap(option => option.preview),
  ].map(path => path.map(displayPoint)), size.value.width, size.value.height, 44);
  if (!fitted) return;
  view = fitted;
  baseScale = fitted.scale;
  requestRender();
}

function resetView(): void {
  fit();
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
  if (!view) fit(); else requestRender();
}

function setBasemap(next: JunctionBasemap): void {
  if (basemap.value === next || !view) return;
  const geographicCentre = displayCentreOf(view);
  basemap.value = next;
  const nextCentre = centreForProvider(geographicCentre, provider.value);
  const projected = projectMercator(nextCentre.lon, nextCentre.lat);
  view = { ...view, cx: projected.x, cy: projected.y };
  tileState.value = 'loading';
  requestRender();
}

function zoomAt(x: number, y: number, factor: number): void {
  if (!view) return;
  view = zoomViewAt(view, size.value.width, size.value.height, x, y, factor, baseScale * 0.4, baseScale * 40);
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
  ctx.fillStyle = basemap.value === 'amap-satellite' ? 'rgba(4, 10, 7, .30)' : 'rgba(5, 10, 7, .48)';
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
  if (!ctx) return;
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

function drawNode(): void {
  if (!ctx || !view) return;
  const node = screenOf(displayPoint(props.junction.context.center), view, size.value.width, size.value.height);
  ctx.save();
  ctx.shadowColor = 'rgba(216, 255, 98, .65)';
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.arc(node.x, node.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#d8ff62';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#0b120c';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(node.x, node.y, 2.1, 0, Math.PI * 2);
  ctx.fillStyle = '#101610';
  ctx.fill();

  const label = '道岔';
  ctx.font = '600 10px "Noto Sans SC", system-ui, sans-serif';
  const width = ctx.measureText(label).width + 14;
  const x = Math.max(8, Math.min(size.value.width - width - 8, node.x + 12));
  const y = Math.max(8, Math.min(size.value.height - 26, node.y - 29));
  ctx.fillStyle = 'rgba(9, 15, 10, .88)';
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

function drawOptionBadge(path: ScreenPath, index: number, color: string, selected: boolean): void {
  if (!ctx) return;
  const point = pointAtPathFraction(path, 0.66);
  const radius = selected ? 11 : 9.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#d8ff62' : 'rgba(8, 15, 10, .94)';
  ctx.fill();
  ctx.strokeStyle = selected ? '#f2ffd1' : color;
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.stroke();
  ctx.fillStyle = selected ? '#111710' : color;
  ctx.font = `700 ${selected ? 9.5 : 8.5}px "Barlow Condensed", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index + 1).padStart(2, '0'), point.x, point.y + 0.5);
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
    ctx.fillText('没有可显示的道岔预览数据', width / 2, height / 2);
    return;
  }

  // Background yard and parallel-running lines provide geographic context, never a selectable route.
  for (const track of props.junction.context.tracks) {
    const points = screenPath(track.segmentId, track.points).points;
    strokePath(points, 'rgba(4, 10, 6, .82)', 3.6);
    strokePath(points, 'rgba(199, 211, 193, .42)', 1.2);
  }

  const incomingPath = screenPath('__incoming__', props.junction.context.incoming);
  strokePath(incomingPath.points, 'rgba(3, 9, 5, .95)', 7);
  strokePath(incomingPath.points, '#eef3e6', 2.8);
  for (const fraction of [0.25, 0.62, 0.88]) drawArrow(incomingPath, fraction, '#eef3e6', 6.5);

  const optionPaths = props.junction.options.map((option) => screenPath(option.segmentId, option.preview));
  hitPaths = optionPaths;
  for (const path of optionPaths) {
    const hovering = path.id === hoverId.value;
    strokePath(path.points, 'rgba(2, 8, 5, .94)', hovering ? 8 : 5.5);
    strokePath(path.points, hovering ? '#d9feff' : '#7fdde7', hovering ? 3.6 : 2.2);
  }

  const selectedIndex = props.junction.options.findIndex(option => option.segmentId === props.selected);
  const selectedPath = selectedIndex >= 0 ? optionPaths[selectedIndex] : undefined;
  if (selectedPath) {
    ctx.save();
    ctx.shadowColor = 'rgba(216, 255, 98, .7)';
    ctx.shadowBlur = 14;
    strokePath(selectedPath.points, '#061008', 8.5);
    ctx.restore();
    strokePath(selectedPath.points, '#d8ff62', 4);
    for (const fraction of [0.16, 0.42, 0.7, 0.9]) drawArrow(selectedPath, fraction, '#d8ff62', 8);
  }

  for (const [index, path] of optionPaths.entries()) drawOptionBadge(path, index, '#7fdde7', index === selectedIndex);
  drawNode();
  drawNorthArrow(ctx);
  drawScaleBar(ctx, view, width, height, props.junction.context.center.lat);

  if (props.junction.options.length === 0) {
    ctx.fillStyle = 'rgba(229, 237, 223, .55)';
    ctx.font = '12px "Noto Sans SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('没有可选线路', width / 2, height / 2);
  }
}

function localPoint(event: PointerEvent | WheelEvent | MouseEvent): ScreenPoint {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function findOptionAt(point: ScreenPoint): string | undefined {
  return closestScreenPath(hitPaths, point.x, point.y, 14);
}

function updateHover(point: ScreenPoint): void {
  const id = findOptionAt(point);
  if (id !== hoverId.value) {
    hoverId.value = id;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = id ? 'pointer' : 'grab';
}

function touchPair(): [ScreenPoint, ScreenPoint] | undefined {
  if (pointers.size < 2) return;
  const points = [...pointers.values()];
  return [points[0], points[1]];
}

function startPinch(): void {
  const pair = touchPair();
  if (!pair || !view) return;
  drag = undefined;
  gestureMoved = true;
  pinch = {
    distance: Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y)),
    midpoint: { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 },
    view: { ...view },
  };
}

function updatePinch(): void {
  const pair = touchPair();
  if (!pair || !pinch) return;
  const distance = Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y));
  const midpoint = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
  view = pinchView(pinch.view, size.value.width, size.value.height, pinch.midpoint, pinch.distance, midpoint, distance, baseScale * 0.4, baseScale * 40);
  requestRender();
}

function releasePointer(event: PointerEvent): void {
  try {
    if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId);
  } catch {
    /* The pointer may already be released or synthetic. */
  }
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || !view) return;
  const point = localPoint(event);
  pointers.set(event.pointerId, point);
  try { canvas.value?.setPointerCapture(event.pointerId); } catch { /* Synthetic events and older browsers may not own the pointer. */ }
  if (pointers.size >= 2) {
    startPinch();
  } else {
    gestureMoved = false;
    drag = { ...point, start: { ...view }, moved: false };
  }
  if (hoverId.value) {
    hoverId.value = undefined;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = 'grabbing';
}

function onPointerMove(event: PointerEvent): void {
  const point = localPoint(event);
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, point);
  if (pointers.size >= 2) {
    updatePinch();
    return;
  }
  if (drag) {
    const dx = point.x - drag.x;
    const dy = point.y - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    view = panViewBy(drag.start, dx, dy);
    requestRender();
    return;
  }
  updateHover(point);
}

function finishPointer(event: PointerEvent, allowSelect: boolean): void {
  const point = localPoint(event);
  pointers.delete(event.pointerId);
  releasePointer(event);
  if (pointers.size >= 2) {
    updatePinch();
    return;
  }
  if (pointers.size === 1) {
    pinch = undefined;
    const remaining = [...pointers.values()][0];
    // Continue one-finger panning after a pinch, but never turn it into a click.
    drag = { ...remaining, start: view ? { ...view } : { cx: 0, cy: 0, scale: 1 }, moved: true };
    return;
  }
  pinch = undefined;
  const wasMoved = drag?.moved ?? true;
  drag = undefined;
  const id = findOptionAt(point);
  hoverId.value = id;
  if (canvas.value) canvas.value.style.cursor = id ? 'pointer' : 'grab';
  requestRender();
  if (allowSelect && !wasMoved && !gestureMoved && id) emit('select', id);
  gestureMoved = false;
}

function onPointerUp(event: PointerEvent): void {
  finishPointer(event, true);
}

function onPointerCancel(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  releasePointer(event);
  if (pointers.size === 0) {
    drag = undefined;
    pinch = undefined;
    gestureMoved = false;
    if (canvas.value) canvas.value.style.cursor = 'grab';
    return;
  }
  if (pointers.size < 2) {
    pinch = undefined;
    const remaining = [...pointers.values()][0];
    drag = { ...remaining, start: view ? { ...view } : { cx: 0, cy: 0, scale: 1 }, moved: true };
  }
}

function onPointerLeave(): void {
  if (drag || pointers.size) return;
  if (hoverId.value) {
    hoverId.value = undefined;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = 'grab';
}

function onKeyDown(event: KeyboardEvent): void {
  if ((event.code === 'Enter' || event.code === 'Space') && hoverId.value) {
    event.preventDefault();
    emit('select', hoverId.value);
  } else if (event.code === 'Equal' || event.code === 'NumpadAdd') {
    event.preventDefault();
    zoomButton(1.5);
  } else if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
    event.preventDefault();
    zoomButton(1 / 1.5);
  } else if (event.code === 'Digit0' || event.code === 'Numpad0') {
    event.preventDefault();
    resetView();
  }
}

watch(() => props.selected, requestRender);
watch(() => props.junction.nodeId, () => { hoverId.value = undefined; view = undefined; fit(); });
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
  <div ref="host" class="junction-map-host">
    <canvas ref="canvas" class="junction-map-canvas" role="img" tabindex="0" aria-label="附近配线图。点击线路选择走行路径；滚轮或双指缩放，拖动平移，也可使用加号和减号按钮缩放。" @wheel.prevent="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @pointerleave="onPointerLeave" @keydown="onKeyDown" />
    <div class="junction-map-toolbar" aria-label="底图选择">
      <span>高德底图</span>
      <button :class="{ active: basemap === 'amap-satellite' }" :aria-pressed="basemap === 'amap-satellite'" @click="setBasemap('amap-satellite')">卫星</button>
      <button :class="{ active: basemap === 'amap-street' }" :aria-pressed="basemap === 'amap-street'" @click="setBasemap('amap-street')">街道</button>
    </div>
    <div class="junction-map-zoom" aria-label="地图缩放">
      <button aria-label="放大" title="放大" @click="zoomButton(1.5)">＋</button>
      <button aria-label="缩小" title="缩小" @click="zoomButton(1 / 1.5)">−</button>
      <button aria-label="复位视图" title="复位视图" @click="resetView">⤢</button>
    </div>
    <p v-if="basemapNotice" class="junction-map-notice" role="status">{{ basemapNotice }}</p>
    <p v-if="hoveredOption" class="junction-map-hover">
      点击选择 {{ String(junction.options.indexOf(hoveredOption) + 1).padStart(2, '0') }} · {{ hoveredOption.name }}
    </p>
    <p v-else class="junction-map-pan-hint">滚轮/双指缩放 · 拖动平移 · 点击线路选择</p>
    <p class="junction-map-attribution">{{ provider.attribution }}{{ coordinateNotice }}</p>
    <p v-if="!optionCount" class="junction-map-notice error">没有可选线路</p>
  </div>
</template>

<style scoped>
.junction-map-host { position: relative; flex: 1; min-height: 0; overflow: hidden; border: 1px solid rgba(255,255,255,.14); background: #0b120d; }
.junction-map-canvas { display: block; width: 100%; height: 100%; outline: none; cursor: grab; touch-action: none; }
.junction-map-canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.junction-map-toolbar { position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 3px; padding: 4px; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .84); backdrop-filter: blur(8px); }
.junction-map-toolbar span { padding: 0 5px; color: #8e9b89; font-size: 9px; letter-spacing: .5px; }
.junction-map-toolbar button { min-height: 25px; padding: 0 8px; border: 1px solid transparent; color: #b8c4b2; background: transparent; font-size: 9px; }
.junction-map-toolbar button:hover { color: #f1f7eb; border-color: rgba(255,255,255,.22); }
.junction-map-toolbar button.active { border-color: var(--accent); color: #111710; background: var(--accent); }
.junction-map-zoom { position: absolute; top: 54px; right: 12px; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .84); backdrop-filter: blur(8px); }
.junction-map-zoom button { width: 30px; height: 28px; border: 0; border-bottom: 1px solid rgba(255,255,255,.1); color: #dbe5d5; background: transparent; font-size: 14px; line-height: 1; }
.junction-map-zoom button:last-child { border-bottom: 0; font-size: 12px; }
.junction-map-zoom button:hover { color: #111710; background: var(--accent); }
.junction-map-notice { position: absolute; top: 12px; left: 50%; margin: 0; padding: 5px 9px; color: #d7e5cf; background: rgba(8, 14, 9, .84); border: 1px solid rgba(255,255,255,.13); font-size: 9px; transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.junction-map-notice.error { color: #ffd0c5; border-color: #714a41; }
.junction-map-hover { position: absolute; bottom: 13px; left: 50%; max-width: min(80%, 440px); margin: 0; padding: 6px 10px; overflow: hidden; color: #eff8e8; background: rgba(8, 14, 9, .92); border: 1px solid rgba(127, 221, 231, .45); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; transform: translateX(-50%); pointer-events: none; }
.junction-map-pan-hint { position: absolute; bottom: 11px; left: 50%; margin: 0; padding: 4px 8px; color: rgba(229, 238, 222, .7); background: rgba(8, 14, 9, .7); font-size: 8.5px; transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.junction-map-attribution { position: absolute; right: 9px; bottom: 7px; max-width: 62%; margin: 0; overflow: hidden; color: rgba(228, 238, 222, .62); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; text-align: right; pointer-events: none; }
@media (max-width: 620px) {
  .junction-map-toolbar { top: 8px; right: 8px; }
  .junction-map-toolbar span { display: none; }
  .junction-map-zoom { top: 48px; right: 8px; }
  .junction-map-notice { top: 8px; left: 8px; max-width: calc(100% - 132px); overflow: hidden; text-overflow: ellipsis; transform: none; }
  .junction-map-hover { bottom: 10px; max-width: calc(100% - 60px); }
  .junction-map-pan-hint { display: none; }
  .junction-map-attribution { max-width: 52%; font-size: 7px; }
}
</style>
