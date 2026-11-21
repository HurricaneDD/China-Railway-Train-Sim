<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ProvinceInfo } from '../types';
import { CHINA_PROVINCES, CHINA_PROVINCE_VIEWBOX, type ChinaProvinceShape } from '../data/chinaProvinces';

const props = defineProps<{
  provinces: ProvinceInfo[];
  stationCounts: Map<string, number>;
  hidden?: string[];
  selected?: string;
}>();
const emit = defineEmits<{ select: [province: ProvinceInfo] }>();

interface ProvinceMapItem extends ChinaProvinceShape {
  info?: ProvinceInfo;
  selectable: boolean;
  stationCount: number;
}

const [baseX, baseY, baseWidth, baseHeight] = CHINA_PROVINCE_VIEWBOX.split(' ').map(Number);
const BASE = { x: baseX, y: baseY, w: baseWidth, h: baseHeight };
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;
// Start slightly tighter than the full country while keeping every province reachable.
const DEFAULT_ZOOM = 2;
// At 2× the whole country no longer fits; bias the initial view toward the
// populated/rail-rich east while keeping zoom-out and pan available.
const DEFAULT_CENTER = { x: 640, y: 480 };

const svg = ref<SVGSVGElement>();
const hovered = ref<string>();
const zoom = ref(DEFAULT_ZOOM);
const view = ref(defaultView());
let drag: { pointerId: number; clientX: number; clientY: number; view: { x: number; y: number; w: number; h: number }; moved: boolean; captured: boolean } | undefined;
let pinch: { distance: number; zoom: number; anchor: { x: number; y: number }; lastMid: { x: number; y: number } } | undefined;
const pointers = new Map<number, { x: number; y: number }>();
let suppressClick = false;

function defaultView(): { x: number; y: number; w: number; h: number } {
  const w = BASE.w / DEFAULT_ZOOM;
  const h = BASE.h / DEFAULT_ZOOM;
  return {
    x: clamp(DEFAULT_CENTER.x - w / 2, BASE.x, BASE.x + BASE.w - w),
    y: clamp(DEFAULT_CENTER.y - h / 2, BASE.y, BASE.y + BASE.h - h),
    w,
    h,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const viewBox = computed(() => `${view.value.x.toFixed(2)} ${view.value.y.toFixed(2)} ${view.value.w.toFixed(2)} ${view.value.h.toFixed(2)}`);
const canZoomIn = computed(() => zoom.value < MAX_ZOOM - 0.001);
const canZoomOut = computed(() => zoom.value > MIN_ZOOM + 0.001);

function applyZoom(next: number, anchorX?: number, anchorY?: number): void {
  const value = clamp(next, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(value - zoom.value) < 0.0001) return;
  const current = view.value;
  const ax = anchorX ?? current.x + current.w / 2;
  const ay = anchorY ?? current.y + current.h / 2;
  const w = BASE.w / value;
  const h = BASE.h / value;
  const x = clamp(ax - (ax - current.x) * (w / current.w), BASE.x, BASE.x + BASE.w - w);
  const y = clamp(ay - (ay - current.y) * (h / current.h), BASE.y, BASE.y + BASE.h - h);
  zoom.value = value;
  view.value = { x, y, w, h };
}

function resetView(): void {
  zoom.value = DEFAULT_ZOOM;
  view.value = defaultView();
}

function clientToMap(clientX: number, clientY: number): { x: number; y: number } | undefined {
  const matrix = svg.value?.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function onWheel(event: WheelEvent): void {
  const anchor = clientToMap(event.clientX, event.clientY);
  if (!anchor) return;
  applyZoom(zoom.value * Math.exp(-event.deltaY * 0.0015), anchor.x, anchor.y);
}

function touchPair(): [{ x: number; y: number }, { x: number; y: number }] | undefined {
  if (pointers.size < 2) return;
  const values = [...pointers.values()];
  return [values[0], values[1]];
}

function touchMidpoint(pair: [{ x: number; y: number }, { x: number; y: number }]): { x: number; y: number } {
  return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
}

function startPinch(container: Element): void {
  const pair = touchPair();
  if (!pair) return;
  const mid = touchMidpoint(pair);
  const anchor = clientToMap(mid.x, mid.y);
  if (!anchor) return;
  drag = undefined;
  suppressClick = true;
  pinch = {
    distance: Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y)),
    zoom: zoom.value,
    anchor,
    lastMid: mid,
  };
  // Capture both touch points so the gesture survives a finger leaving the map.
  for (const pointerId of pointers.keys()) {
    if (!container.hasPointerCapture(pointerId)) container.setPointerCapture(pointerId);
  }
}

function updatePinch(): void {
  const pair = touchPair();
  if (!pair || !pinch) return;
  const distance = Math.max(1, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y));
  const mid = touchMidpoint(pair);
  applyZoom(pinch.zoom * (distance / pinch.distance), pinch.anchor.x, pinch.anchor.y);
  const matrix = svg.value?.getScreenCTM();
  const dx = mid.x - pinch.lastMid.x;
  const dy = mid.y - pinch.lastMid.y;
  if (matrix && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) {
    const x = clamp(view.value.x - dx / matrix.a, BASE.x, BASE.x + BASE.w - view.value.w);
    const y = clamp(view.value.y - dy / matrix.d, BASE.y, BASE.y + BASE.h - view.value.h);
    view.value = { ...view.value, x, y };
  }
  pinch.lastMid = mid;
}

function onPointerDown(event: PointerEvent): void {
  if (event.button !== 0 || (event.target as Element).closest('.province-map-zoom')) return;
  // Hover is a mouse affordance only; long-pressing a province on touch must
  // not pop the station-count readout.
  if (event.pointerType !== 'mouse') hovered.value = undefined;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  suppressClick = false;
  if (pointers.size >= 2) {
    startPinch(event.currentTarget as Element);
    return;
  }
  drag = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, view: { ...view.value }, moved: false, captured: false };
}

function onPointerMove(event: PointerEvent): void {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size >= 2) {
    updatePinch();
    return;
  }
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.clientX;
  const dy = event.clientY - drag.clientY;
  if (!drag.moved && Math.hypot(dx, dy) > 3) {
    drag.moved = true;
    drag.captured = true;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  if (!drag.moved) return;
  const matrix = svg.value?.getScreenCTM();
  if (!matrix) return;
  const x = clamp(drag.view.x - dx / matrix.a, BASE.x, BASE.x + BASE.w - view.value.w);
  const y = clamp(drag.view.y - dy / matrix.d, BASE.y, BASE.y + BASE.h - view.value.h);
  view.value = { ...view.value, x, y };
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  if (pointers.size >= 2) return;
  if (pointers.size === 1) {
    pinch = undefined;
    const [pointerId, point] = [...pointers.entries()][0];
    drag = { pointerId, clientX: point.x, clientY: point.y, view: { ...view.value }, moved: true, captured: true };
    return;
  }
  pinch = undefined;
  const moved = drag?.moved ?? true;
  drag = undefined;
  if (moved) suppressClick = true;
}

function onPointerCancel(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  if (pointers.size === 0) {
    drag = undefined;
    pinch = undefined;
    return;
  }
  if (pointers.size < 2) {
    pinch = undefined;
    const [pointerId, point] = [...pointers.entries()][0];
    drag = { pointerId, clientX: point.x, clientY: point.y, view: { ...view.value }, moved: true, captured: true };
  }
}

function onClickCapture(event: MouseEvent): void {
  if (!suppressClick) return;
  event.stopPropagation();
  event.preventDefault();
  suppressClick = false;
}

function zoomBy(factor: number): void {
  applyZoom(zoom.value * factor);
}

const items = computed<ProvinceMapItem[]>(() => {
  const byAdcode = new Map(props.provinces.map(province => [province.adcode, province]));
  const hidden = new Set(props.hidden ?? []);
  return CHINA_PROVINCES.map((shape) => {
    const info = byAdcode.get(shape.adcode);
    return {
      ...shape,
      info,
      selectable: !!info && !hidden.has(info.province),
      stationCount: info ? (props.stationCounts.get(info.province) ?? 0) : 0,
    };
  });
});
const hoveredItem = computed(() => items.value.find(item => item.adcode === hovered.value));

function labelInView(item: ProvinceMapItem): boolean {
  // Only draw labels whose whole text box stays inside the visible viewBox;
  // this avoids half-cut province names at the edges of a zoomed map.
  const halfWidth = 20;
  const halfHeight = 12;
  return item.lx - halfWidth >= view.value.x && item.lx + halfWidth <= view.value.x + view.value.w
    && item.ly - halfHeight >= view.value.y && item.ly + halfHeight <= view.value.y + view.value.h;
}

function choose(item: ProvinceMapItem): void {
  if (item.selectable && item.info) emit('select', item.info);
}

function enter(item: ProvinceMapItem, event?: PointerEvent): void {
  if (event && event.pointerType !== 'mouse') return;
  hovered.value = item.adcode;
}

function onFocus(item: ProvinceMapItem, event: FocusEvent): void {
  // Touch focus must not be treated as hover; only keyboard/programmatic
  // focus-visible gets the station-count readout.
  const target = event.target as Element | null;
  if (target && !target.matches(':focus-visible')) return;
  hovered.value = item.adcode;
}

function leave(): void {
  if (drag || pointers.size) return;
  hovered.value = undefined;
}

function onKeydown(event: KeyboardEvent, item: ProvinceMapItem): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  choose(item);
}
</script>

<template>
  <div class="province-map" @pointerleave="leave" @wheel.prevent="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerCancel" @click.capture="onClickCapture">
    <svg ref="svg" class="province-map-svg" :viewBox="viewBox" role="group" aria-label="中国省级行政区划图，点击有车站数据的省份选择始发位置">
      <g class="province-map-regions">
        <path
          v-for="item in items"
          :key="item.adcode"
          :d="item.d"
          :data-adcode="item.adcode"
          fill-rule="evenodd"
          :class="{ selectable: item.selectable, disabled: !item.selectable, selected: item.info?.province === selected, hovered: hovered === item.adcode }"
          :tabindex="item.selectable ? 0 : -1"
          :role="item.selectable ? 'button' : 'img'"
          :aria-label="item.selectable ? `${item.info?.province}，${item.stationCount} 个有坐标车站` : `${item.name}，暂无车站数据`"
          :aria-disabled="!item.selectable"
          @click="choose(item)"
          @pointerenter="enter(item, $event)"
          @focus="onFocus(item, $event)"
          @blur="leave()"
          @keydown="onKeydown($event, item)"
        />
      </g>
      <g class="province-map-labels">
        <g
          v-for="item in items"
          v-show="labelInView(item)"
          :key="`label-${item.adcode}`"
          class="province-label"
          :class="{ disabled: !item.selectable, selected: item.info?.province === selected }"
          @click="choose(item)"
          @pointerenter="enter(item, $event)"
        >
          <line v-if="item.leader" :x1="item.cx" :y1="item.cy" :x2="item.lx" :y2="item.ly" />
          <circle v-if="item.leader" :cx="item.cx" :cy="item.cy" :r="2.6 / zoom" />
          <text :x="item.lx" :y="item.ly" :style="{ fontSize: `${20 / zoom}px`, strokeWidth: `${3 / zoom}px` }">{{ item.shortName }}</text>
        </g>
      </g>
    </svg>

    <div class="province-map-zoom" aria-label="地图缩放">
      <button type="button" aria-label="放大地图" title="放大" :disabled="!canZoomIn" @click.stop="zoomBy(1.25)">＋</button>
      <button type="button" aria-label="缩小地图" title="缩小" :disabled="!canZoomOut" @click.stop="zoomBy(1 / 1.25)">−</button>
      <button type="button" aria-label="复位地图" title="复位" @click.stop="resetView">⤢</button>
    </div>

    <p v-if="hoveredItem" class="province-map-readout" aria-live="polite">
      <strong>{{ hoveredItem.info?.province ?? hoveredItem.name }}</strong>
      <span v-if="hoveredItem.selectable">{{ hoveredItem.stationCount }} 个有坐标车站</span>
      <span v-else class="unavailable">暂无车站数据</span>
    </p>
  </div>
</template>

<style scoped>
.province-map { position: relative; display: flex; flex: 1; align-items: center; justify-content: center; min-height: 0; overflow: hidden; border: 1px solid rgba(255,255,255,.1); background: radial-gradient(circle at 50% 42%, rgba(38, 54, 38, .55), rgba(9, 14, 10, .9) 72%); cursor: grab; touch-action: none; }
.province-map:active { cursor: grabbing; }
.province-map-svg { display: block; width: 100%; height: 100%; }
.province-map-svg path { fill: #232d24; stroke: #66735f; stroke-width: 1; vector-effect: non-scaling-stroke; cursor: pointer; outline: none; transition: fill .14s, stroke .14s; }
.province-map-svg path.disabled { fill: #171c18; stroke: #3a4338; cursor: not-allowed; }
.province-map-svg path.selectable:hover, .province-map-svg path.hovered { fill: #34472d; stroke: #d8ff62; }
.province-map-svg path.selected { fill: rgba(216, 255, 98, .16); stroke: #d8ff62; }
.province-map-svg path:focus-visible { stroke: #d8ff62; stroke-width: 2; }
.province-label { pointer-events: none; }
.province-label text { fill: #e2eade; stroke: #0c120d; stroke-width: 3; paint-order: stroke; font-size: 20px; font-weight: 500; text-anchor: middle; dominant-baseline: middle; pointer-events: auto; cursor: pointer; }
.province-label.disabled text { fill: #5f695c; cursor: not-allowed; }
.province-label.selected text { fill: #d8ff62; }
.province-label line { stroke: rgba(216, 255, 98, .38); stroke-width: 1; vector-effect: non-scaling-stroke; }
.province-label circle { fill: #d8ff62; }
.province-map-readout { position: absolute; top: 10px; left: 10px; max-width: calc(100% - 60px); margin: 0; padding: 5px 9px; color: #dbe5d5; background: rgba(8, 14, 9, .86); border: 1px solid rgba(255,255,255,.13); font-size: 10px; line-height: 1.4; pointer-events: none; }
.province-map-readout strong { margin-right: 8px; color: #f0f6ea; font-weight: 500; }
.province-map-readout .unavailable { color: #8a9586; }
.province-map-zoom { position: absolute; top: 50%; right: 8px; display: flex; flex-direction: column; border: 1px solid rgba(255,255,255,.16); background: rgba(8, 14, 9, .86); backdrop-filter: blur(8px); transform: translateY(-50%); }
.province-map-zoom button { width: 32px; height: 30px; border: 0; border-bottom: 1px solid rgba(255,255,255,.1); color: #dbe5d5; background: transparent; font-size: 15px; line-height: 1; }
.province-map-zoom button:last-child { border-bottom: 0; font-size: 13px; }
.province-map-zoom button:not(:disabled):hover { color: #111710; background: var(--accent); }
.province-map-zoom button:disabled { color: #596356; opacity: .55; }
@media (max-width: 620px) {
  .province-label text { font-size: 22px; }
  .province-map-readout { right: 7px; bottom: 7px; font-size: 9px; }
  .province-map-zoom { top: 50%; right: 6px; }
  .province-map-zoom button { width: 30px; height: 28px; }
}
</style>
