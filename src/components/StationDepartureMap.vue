<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StationDeparture, StationDepartureTrack } from '../types';
import { BASEMAPS, type BasemapId } from '../map/basemap';
import { BasemapTiles, drawMapBackground, drawNorthArrow, drawScaleBar } from '../map/canvasLayer';
import { closestScreenPath, fitLonLatPaths, pointAtPathFraction, screenOf, type MapView, type ScreenPath, type ScreenPoint } from '../map/junctionMap';
import { departureBearing, departureDirection } from '../data/stationDeparture';
import { compassDirection } from '../utils/geo';

const props = defineProps<{ departure: StationDeparture; tracks: StationDepartureTrack[]; selected?: string; up: boolean }>();
const emit = defineEmits<{ select: [segmentId: string] }>();

const host = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const basemap = ref<Exclude<BasemapId, 'none'>>('satellite');
const hoverId = ref<string>();
const tileState = ref<'loading' | 'ready' | 'error'>('loading');
const size = ref({ width: 0, height: 0 });

let ctx: CanvasRenderingContext2D | null = null;
let view: MapView | undefined;
let resizeObserver: ResizeObserver | undefined;
let renderFrame = 0;
let disposed = false;
let hitPaths: ScreenPath[] = [];
const tiles = new BasemapTiles();

const provider = computed(() => BASEMAPS[basemap.value]);
const hoveredTrack = computed(() => props.tracks.find(track => track.segmentId === hoverId.value));
const activeTrack = computed(() => props.tracks.find(track => track.segmentId === props.selected));
const directionText = computed(() => activeTrack.value
  ? `${props.up ? '上行' : '下行'} · 推定${compassDirection(departureBearing(activeTrack.value, props.up))}`
  : '尚未选择股道');
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

function fit(): void {
  if (!size.value.width || !size.value.height) return;
  // Fit the selectable tracks and the station; context tracks may extend beyond the viewport.
  view = fitLonLatPaths([
    ...props.tracks.map(track => track.points),
    [{ lon: props.departure.center.lon, lat: props.departure.center.lat }],
  ], size.value.width, size.value.height, 46, 260);
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
  fit();
}

function setBasemap(next: Exclude<BasemapId, 'none'>): void {
  if (basemap.value === next) return;
  basemap.value = next;
  tileState.value = 'loading';
  requestRender();
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
  ctx.fillStyle = basemap.value === 'satellite' ? 'rgba(4, 10, 7, .34)' : 'rgba(5, 10, 7, .42)';
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

  const label = props.departure.station.name || '车站';
  ctx.font = '600 10px "Noto Sans SC", system-ui, sans-serif';
  const width = ctx.measureText(label).width + 16;
  const x = Math.max(8, Math.min(size.value.width - width - 8, node.x + 13));
  const y = Math.max(8, Math.min(size.value.height - 26, node.y - 30));
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

function drawBadge(path: ScreenPath, index: number, selected: boolean): void {
  if (!ctx || path.points.length < 2) return;
  // Stagger labels along parallel station tracks; a fixed midpoint stacks every number at the station.
  const point = pointAtPathFraction(path, 0.3 + ((index * 0.37) % 0.46));
  const radius = selected ? 10.5 : 8.8;
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = selected ? '#d8ff62' : 'rgba(8, 15, 10, .94)';
  ctx.fill();
  ctx.strokeStyle = selected ? '#f2ffd1' : '#7fdde7';
  ctx.lineWidth = selected ? 2 : 1.5;
  ctx.stroke();
  ctx.fillStyle = selected ? '#111710' : '#9be8ef';
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
    ctx.fillText('没有可显示的股道', width / 2, height / 2);
    return;
  }

  const candidateIds = new Set(props.tracks.map(track => track.segmentId));
  // Context tracks are nearby OSM geometry only; they are never selectable.
  for (const track of props.departure.contextTracks) {
    if (candidateIds.has(track.segmentId)) continue;
    strokePath(screenPath(track.segmentId, track.points).points, 'rgba(4, 10, 6, .78)', 3.2);
    strokePath(screenPath(track.segmentId, track.points).points, 'rgba(199, 211, 193, .32)', 1);
  }

  const paths = props.tracks.map(track => screenPath(track.segmentId, track.points));
  hitPaths = paths;
  for (const path of paths) {
    const hovering = path.id === hoverId.value;
    strokePath(path.points, 'rgba(2, 8, 5, .94)', hovering ? 7 : 5);
    strokePath(path.points, hovering ? '#d9feff' : '#7fdde7', hovering ? 3.4 : 2);
  }

  const selectedIndex = props.tracks.findIndex(track => track.segmentId === props.selected);
  const selectedPath = selectedIndex >= 0 ? paths[selectedIndex] : undefined;
  if (selectedPath) {
    const track = props.tracks[selectedIndex];
    ctx.save();
    ctx.shadowColor = 'rgba(216, 255, 98, .7)';
    ctx.shadowBlur = 14;
    strokePath(selectedPath.points, '#061008', 8.5);
    ctx.restore();
    strokePath(selectedPath.points, '#d8ff62', 4);
    const directed: ScreenPath = { id: selectedPath.id, points: departureDirection(track, props.up) > 0 ? selectedPath.points : [...selectedPath.points].reverse() };
    for (const fraction of [0.18, 0.42, 0.66, 0.9]) drawArrow(directed, fraction, '#d8ff62', 8);
  }

  for (const [index, path] of paths.entries()) drawBadge(path, index, index === selectedIndex);
  drawStation();
  drawNorthArrow(ctx);
  drawScaleBar(ctx, view, width, height, props.departure.center.lat);

  if (!props.tracks.length) {
    ctx.fillStyle = 'rgba(229, 237, 223, .55)';
    ctx.font = '12px "Noto Sans SC", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('没有可选股道', width / 2, height / 2);
  } else if (activeTrack.value) {
    ctx.fillStyle = 'rgba(216, 255, 98, .92)';
    ctx.font = '600 10px "Noto Sans SC", system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(directionText.value, 56, 24);
  }
}

function localPoint(event: PointerEvent | MouseEvent): ScreenPoint {
  const rect = canvas.value!.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function findTrackAt(point: ScreenPoint): string | undefined {
  return closestScreenPath(hitPaths, point.x, point.y, 14);
}

function onPointerMove(event: PointerEvent): void {
  const id = findTrackAt(localPoint(event));
  if (id !== hoverId.value) {
    hoverId.value = id;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = id ? 'pointer' : 'default';
}

function onPointerLeave(): void {
  if (hoverId.value) {
    hoverId.value = undefined;
    requestRender();
  }
  if (canvas.value) canvas.value.style.cursor = 'default';
}

function onClick(event: MouseEvent): void {
  const id = findTrackAt(localPoint(event));
  if (id) emit('select', id);
}

function onKeyDown(event: KeyboardEvent): void {
  if ((event.code === 'Enter' || event.code === 'Space') && hoverId.value) {
    event.preventDefault();
    emit('select', hoverId.value!);
  }
}

watch(() => props.selected, requestRender);
watch(() => props.up, requestRender);
watch(() => props.tracks, fit);
watch(() => props.departure.station.telecode, () => { hoverId.value = undefined; fit(); });
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
  <div ref="host" class="departure-map-host">
    <canvas ref="canvas" class="departure-map-canvas" role="img" tabindex="0" aria-label="车站配线图。青色线路为可选始发股道，点击线路或按回车选择；灰色线路为周边其它轨道。" @pointermove="onPointerMove" @pointerleave="onPointerLeave" @click="onClick" @keydown="onKeyDown" />
    <div class="departure-map-toolbar" aria-label="底图选择">
      <span>底图</span>
      <button :class="{ active: basemap === 'satellite' }" :aria-pressed="basemap === 'satellite'" @click="setBasemap('satellite')">卫星</button>
      <button :class="{ active: basemap === 'street' }" :aria-pressed="basemap === 'street'" @click="setBasemap('street')">街道</button>
    </div>
    <p v-if="basemapNotice" class="departure-map-notice" role="status">{{ basemapNotice }}</p>
    <p v-if="hoveredTrack" class="departure-map-hover">
      点击选择 {{ String(tracks.indexOf(hoveredTrack) + 1).padStart(2, '0') }} · {{ hoveredTrack.name }} · 距站 {{ Math.round(hoveredTrack.distance) }} m
    </p>
    <p class="departure-map-attribution">{{ provider.attribution }}</p>
    <p v-if="!tracks.length" class="departure-map-notice error">没有可选股道</p>
  </div>
</template>

<style scoped>
.departure-map-host { position: relative; flex: 1; min-height: 0; overflow: hidden; border: 1px solid rgba(255,255,255,.14); background: #0b120d; }
.departure-map-canvas { display: block; width: 100%; height: 100%; outline: none; }
.departure-map-canvas:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.departure-map-toolbar { position: absolute; top: 12px; right: 12px; display: flex; align-items: center; gap: 3px; padding: 4px; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .84); backdrop-filter: blur(8px); }
.departure-map-toolbar span { padding: 0 5px; color: #8e9b89; font-size: 9px; letter-spacing: .5px; }
.departure-map-toolbar button { min-height: 25px; padding: 0 8px; border: 1px solid transparent; color: #b8c4b2; background: transparent; font-size: 9px; }
.departure-map-toolbar button:hover { color: #f1f7eb; border-color: rgba(255,255,255,.22); }
.departure-map-toolbar button.active { border-color: var(--accent); color: #111710; background: var(--accent); }
.departure-map-notice { position: absolute; top: 12px; left: 50%; margin: 0; padding: 5px 9px; color: #d7e5cf; background: rgba(8, 14, 9, .84); border: 1px solid rgba(255,255,255,.13); font-size: 9px; transform: translateX(-50%); white-space: nowrap; pointer-events: none; }
.departure-map-notice.error { color: #ffd0c5; border-color: #714a41; }
.departure-map-hover { position: absolute; bottom: 13px; left: 50%; max-width: min(84%, 460px); margin: 0; padding: 6px 10px; overflow: hidden; color: #eff8e8; background: rgba(8, 14, 9, .92); border: 1px solid rgba(127, 221, 231, .45); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; transform: translateX(-50%); pointer-events: none; }
.departure-map-attribution { position: absolute; right: 9px; bottom: 7px; max-width: 62%; margin: 0; overflow: hidden; color: rgba(228, 238, 222, .62); font-size: 8px; text-overflow: ellipsis; white-space: nowrap; text-align: right; pointer-events: none; }
@media (max-width: 620px) {
  .departure-map-toolbar { top: 8px; right: 8px; }
  .departure-map-toolbar span { display: none; }
  .departure-map-notice { top: 8px; left: 8px; max-width: calc(100% - 142px); overflow: hidden; text-overflow: ellipsis; transform: none; }
  .departure-map-attribution { max-width: 56%; font-size: 7px; }
}
</style>
