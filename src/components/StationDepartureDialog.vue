<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { StationDeparture, StationDepartureLine } from '../types';
import { lineBearing } from '../data/stationDeparture';
import { compassDirection } from '../utils/geo';
import StationDepartureMap from './StationDepartureMap.vue';

const props = defineProps<{ departure: StationDeparture; busy?: boolean }>();
const emit = defineEmits<{ close: []; depart: [payload: { line: StationDepartureLine; direction: 1 | -1 }] }>();

const selected = ref<string>();
const direction = ref<0 | 1 | -1>(0);
const active = computed(() => props.departure.lines.find(line => line.segmentId === selected.value));
const nearest = computed(() => props.departure.lines[0]);

function displayName(line: StationDepartureLine): string {
  return line.name === '未命名铁路' ? '未命名线路' : line.name;
}

function bearingOf(line: StationDepartureLine, sign: 1 | -1): number {
  return lineBearing(line, sign);
}

function directionText(sign: 1 | -1): string {
  return active.value ? `向${compassDirection(bearingOf(active.value, sign))}` : (sign > 0 ? '方向一' : '方向二');
}

function selectLine(segmentId: string): void {
  selected.value = segmentId;
  direction.value = 0;
}

function confirm(): void {
  if (!active.value || direction.value === 0 || props.busy) return;
  emit('depart', { line: active.value, direction: direction.value });
}

function quickStart(sign: 1 | -1): void {
  if (!nearest.value || props.busy) return;
  emit('depart', { line: nearest.value, direction: sign });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.code === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

watch(() => props.departure.station.telecode, () => { selected.value = undefined; direction.value = 0; });

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-backdrop departure-backdrop">
    <section class="departure-dialog" role="dialog" aria-modal="true" aria-labelledby="departure-title">
      <header class="departure-header">
        <div>
          <p class="eyebrow">STATION DEPARTURE · 车站始发</p>
          <h2 id="departure-title">选择始发线路与方向</h2>
          <p class="departure-station">
            {{ departure.station.name }} <span>{{ departure.station.telecode }}</span> · {{ departure.station.province }} {{ departure.station.city }}
          </p>
        </div>
        <button class="departure-close" aria-label="返回重新选站" @click="$emit('close')">×</button>
      </header>

      <div class="departure-body">
        <section class="departure-map-panel" aria-label="车站周边线路图">
          <div class="departure-section-head">
            <div>
              <h3>车站周边线路图</h3>
              <p>直接点击线路选择始发位置；可滚轮缩放、拖动平移。</p>
            </div>
            <span class="departure-map-hint">点击线路选择</span>
          </div>

          <StationDepartureMap :departure="departure" :selected="selected" :direction="direction" @select="selectLine" />

          <div class="departure-legend" aria-label="地图图例">
            <span><i class="legend-line nearby" />附近线路</span>
            <span><i class="legend-line selected" />已选线路</span>
            <span><i class="legend-node" />车站</span>
            <span><i class="legend-arrow">↑</i>运行方向</span>
          </div>
          <p class="departure-caption">底图仅作地理参考；线路来自 OSM 国铁几何，不表示真实站场、线路占用或信号。数据无法判定上下行，方向只按地理方位显示。</p>
        </section>

        <aside class="departure-choice-panel" aria-label="始发线路与方向">
          <section class="departure-block">
            <div class="departure-section-head">
              <div>
                <h3>已选线路</h3>
                <p>在地图上点击一条线路。</p>
              </div>
            </div>
            <div v-if="active" class="line-summary">
              <strong>{{ displayName(active) }}</strong>
              <p>距车站 {{ Math.round(active.distance) }} m · 区段长 {{ Math.round(active.segmentLength) }} m<span v-if="active.bridge"> · 桥</span><span v-if="active.tunnel"> · 隧</span></p>
            </div>
            <p v-else class="empty-selection">尚未选择线路</p>
          </section>

          <section class="departure-block">
            <div class="departure-section-head">
              <div>
                <h3>运行方向</h3>
                <p>选择列车沿该线路的出发方向。</p>
              </div>
            </div>
            <div class="direction-grid" role="radiogroup" aria-label="运行方向">
              <button :class="{ active: direction === 1 }" role="radio" :aria-checked="direction === 1" :disabled="!active" @click="direction = 1">
                <span class="dir-arrow" :style="{ transform: active ? `rotate(${bearingOf(active, 1)}deg)` : 'rotate(0deg)' }" aria-hidden="true">↑</span>
                <span class="dir-copy"><strong>{{ directionText(1) }}</strong><small>{{ active ? `${Math.round(bearingOf(active, 1))}°` : '选择线路后可选' }}</small></span>
              </button>
              <button :class="{ active: direction === -1 }" role="radio" :aria-checked="direction === -1" :disabled="!active" @click="direction = -1">
                <span class="dir-arrow" :style="{ transform: active ? `rotate(${bearingOf(active, -1)}deg)` : 'rotate(0deg)' }" aria-hidden="true">↑</span>
                <span class="dir-copy"><strong>{{ directionText(-1) }}</strong><small>{{ active ? `${Math.round(bearingOf(active, -1))}°` : '选择线路后可选' }}</small></span>
              </button>
            </div>
            <button class="departure-confirm" :disabled="!active || direction === 0 || busy" @click="confirm">
              <span>{{ busy ? '正在进入驾驶…' : '从此线路出发' }}</span>
              <b>→</b>
            </button>
          </section>

          <section class="departure-block quick-block">
            <div class="departure-section-head">
              <div>
                <h3>直接使用最近线路</h3>
                <p v-if="nearest">{{ displayName(nearest) }} · 距车站 {{ Math.round(nearest.distance) }} m</p>
                <p v-else>车站附近没有可用线路</p>
              </div>
            </div>
            <div class="quick-grid">
              <button v-for="sign in ([1, -1] as const)" :key="sign" :disabled="!nearest || busy" @click="quickStart(sign)">
                <span class="dir-arrow" :style="{ transform: nearest ? `rotate(${bearingOf(nearest, sign)}deg)` : 'rotate(0deg)' }" aria-hidden="true">↑</span>
                <span>{{ nearest ? `向${compassDirection(bearingOf(nearest, sign))}出发` : '不可用' }}</span>
              </button>
            </div>
            <p class="departure-note">直接吸附到离车站最近的线路并立即出发。数据不能区分正线与侧线，最近线路不一定是正线。</p>
          </section>

          <p class="departure-fine-print">方向仅决定初始朝向；不推断真实上行/下行、站场归属或线路用途。确认后列车以驻车状态停在线路距站最近点。</p>
        </aside>
      </div>
    </section>
  </div>
</template>

<style scoped>
.departure-backdrop { z-index: 20; padding: 18px; background: rgba(5, 7, 5, .72); }
.departure-dialog { display: flex; flex-direction: column; width: min(1180px, calc(100vw - 36px)); height: min(86vh, 840px); max-height: min(94vh, 900px); overflow: hidden; padding: 0; border: 1px solid rgba(216, 255, 98, .72); background: #131913; box-shadow: 0 30px 120px rgba(0, 0, 0, .58), 0 0 90px rgba(216, 255, 98, .08); text-align: left; }
.departure-header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 20px 26px 16px; border-bottom: 1px solid var(--line); background: linear-gradient(135deg, #1a231a, #121812 72%); }
.departure-dialog .eyebrow { margin: 0 0 5px; color: var(--accent); font-size: 10px; letter-spacing: 2px; }
.departure-dialog h2 { margin: 0; font-size: 24px; font-weight: 600; letter-spacing: -.7px; }
.departure-station { margin: 7px 0 0; color: #b3bdb0; font-size: 11px; }
.departure-station span { margin: 0 4px; color: var(--accent); font-family: 'Barlow Condensed', sans-serif; letter-spacing: 1px; }
.departure-close { width: 34px; height: 34px; flex-shrink: 0; border: 1px solid var(--line); background: transparent; color: #b8bdb5; font-size: 22px; line-height: 1; }
.departure-close:hover { border-color: var(--accent); color: var(--accent); }
.departure-body { display: grid; flex: 1; grid-template-columns: minmax(0, 1.65fr) minmax(330px, .85fr); min-height: 0; }
.departure-map-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 16px 20px 13px; background: #0f1510; }
.departure-choice-panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; min-height: 0; padding: 16px 18px 15px; overflow-y: auto; border-left: 1px solid var(--line); background: #151c16; }
.departure-section-head { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 9px; }
.departure-section-head h3 { margin: 0; color: #e8efe2; font-size: 13px; font-weight: 600; letter-spacing: .2px; }
.departure-section-head p { margin: 4px 0 0; color: #8e9a89; font-size: 9px; line-height: 1.55; }
.departure-map-hint { flex-shrink: 0; padding: 4px 7px; border: 1px solid rgba(127, 221, 231, .25); color: #92e0e8; background: rgba(127, 221, 231, .05); font-size: 9px; white-space: nowrap; }
.departure-map-panel .station-map-host { flex: 1; min-height: 280px; }
.departure-legend { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 7px 15px; margin-top: 9px; color: #9da99a; font-size: 9px; }
.departure-legend span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.departure-legend i { display: inline-block; flex-shrink: 0; }
.legend-line { width: 17px; height: 2px; border-radius: 2px; }
.legend-line.nearby { background: #c7d3c1; opacity: .7; }
.legend-line.selected { height: 4px; background: var(--accent); box-shadow: 0 0 7px rgba(216, 255, 98, .5); }
.legend-node { width: 7px; height: 7px; border-radius: 50%; background: #f4f8ee; box-shadow: 0 0 0 2px rgba(216, 255, 98, .4); }
.legend-arrow { color: #d8ff62; font-size: 11px; font-style: normal; line-height: 1; }
.departure-caption { flex: 0 0 auto; margin: 7px 0 0; color: #778374; font-size: 9px; line-height: 1.55; }
.departure-block { flex: 0 0 auto; }
.line-summary { padding: 10px 11px; border: 1px solid rgba(216, 255, 98, .35); background: rgba(216, 255, 98, .06); }
.line-summary strong { display: block; color: #eef4e8; font-size: 12px; font-weight: 600; }
.line-summary p { margin: 4px 0 0; color: #94a18f; font-size: 9px; }
.empty-selection { margin: 0; padding: 12px; border: 1px dashed rgba(255, 255, 255, .16); color: #8e9a89; font-size: 10px; text-align: center; }
.direction-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.direction-grid button, .quick-grid button { display: flex; align-items: center; gap: 8px; padding: 9px 10px; border: 1px solid rgba(255, 255, 255, .13); background: #1a211b; color: #eef4e8; text-align: left; transition: border-color .15s, background .15s, box-shadow .15s; }
.direction-grid button:hover:not(:disabled), .quick-grid button:hover:not(:disabled) { border-color: rgba(216, 255, 98, .55); background: rgba(216, 255, 98, .055); }
.direction-grid button.active { border-color: var(--accent); background: rgba(216, 255, 98, .1); box-shadow: inset 3px 0 var(--accent); }
.direction-grid button:disabled { opacity: .45; }
.dir-arrow { display: inline-block; flex-shrink: 0; width: 20px; color: var(--accent); font-size: 20px; line-height: 1; text-align: center; transform-origin: center; }
.dir-copy { display: flex; flex-direction: column; min-width: 0; }
.dir-copy strong { font-size: 11px; font-weight: 600; white-space: nowrap; }
.dir-copy small { margin-top: 2px; color: #8d9b88; font-family: 'Barlow Condensed', sans-serif; font-size: 9px; letter-spacing: .5px; }
.departure-confirm { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 44px; margin-top: 9px; padding: 0 14px; border: 1px solid var(--accent); color: #111710; background: var(--accent); font-size: 12px; font-weight: 700; }
.departure-confirm:not(:disabled):hover { background: #e4ff90; }
.departure-confirm:disabled { color: #a1aa9d; border-color: rgba(255, 255, 255, .13); background: #222a23; opacity: 1; }
.departure-confirm b { font-size: 18px; font-weight: 400; }
.quick-block { padding-top: 12px; border-top: 1px solid var(--line); }
.quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.quick-grid button { justify-content: center; color: #d8ff62; font-size: 10px; font-weight: 600; }
.quick-grid button:disabled { opacity: .45; }
.quick-grid .dir-arrow { width: auto; font-size: 16px; }
.departure-note { margin: 7px 0 0; color: #7d8979; font-size: 8.5px; line-height: 1.55; }
.departure-fine-print { margin: auto 0 0; padding-top: 10px; color: #7d8979; font-size: 8.5px; line-height: 1.6; border-top: 1px solid var(--line); }
@media (max-width: 940px) {
  .departure-dialog { width: calc(100vw - 24px); height: auto; max-height: 94vh; overflow-y: auto; }
  .departure-body { display: flex; flex-direction: column; }
  .departure-map-panel { flex: 0 0 auto; padding: 14px 16px 12px; }
  .departure-map-panel .station-map-host { flex: 0 0 380px; height: 380px; min-height: 380px; }
  .departure-choice-panel { flex: 0 0 auto; border-top: 1px solid var(--line); border-left: 0; padding: 14px 16px 16px; }
  .departure-fine-print { margin-top: 4px; }
}
@media (max-width: 620px) {
  .departure-backdrop { padding: 8px; }
  .departure-dialog { width: 100%; max-height: calc(100dvh - 16px); }
  .departure-header { padding: 13px 14px 11px; }
  .departure-dialog h2 { font-size: 20px; }
  .departure-map-panel { padding: 12px 12px 10px; }
  .departure-map-panel .station-map-host { flex-basis: 320px; height: 320px; min-height: 300px; }
  .departure-choice-panel { padding: 12px 12px 14px; }
  .departure-map-hint { display: none; }
  .departure-caption { font-size: 8px; }
  .direction-grid { grid-template-columns: 1fr 1fr; }
}
</style>
