<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { APP_CONFIG } from '../config';
import type { StationDeparture, StationDepartureTrack } from '../types';
import { departureBearing } from '../data/stationDeparture';
import { compassDirection } from '../utils/geo';
import StationDepartureMap from './StationDepartureMap.vue';

const props = defineProps<{ departure: StationDeparture; busy?: boolean }>();
const emit = defineEmits<{ close: []; depart: [payload: { track: StationDepartureTrack; up: boolean }] }>();

const up = ref(true);
const selected = ref<string>();
const visibleLimit = ref(APP_CONFIG.stationDeparture.initialTracks);
const listEl = ref<HTMLElement>();

const visibleTracks = computed(() => props.departure.tracks.slice(0, visibleLimit.value));
const activeIndex = computed(() => visibleTracks.value.findIndex(track => track.segmentId === selected.value));
const active = computed(() => activeIndex.value >= 0 ? visibleTracks.value[activeIndex.value] : undefined);
const upCompass = computed(() => compassDirection(active.value?.upBearing ?? props.departure.towardBeijing));
const downCompass = computed(() => compassDirection(((active.value?.upBearing ?? props.departure.towardBeijing) + 180) % 360));
const selectionCounter = computed(() => activeIndex.value < 0
  ? `-- / ${String(visibleTracks.value.length).padStart(2, '0')}`
  : `${String(activeIndex.value + 1).padStart(2, '0')} / ${String(visibleTracks.value.length).padStart(2, '0')}`);
const remainingTracks = computed(() => props.departure.tracks.length - visibleTracks.value.length);

function displayName(track: StationDepartureTrack): string {
  return track.name === '未命名铁路' ? '未命名股道' : track.name;
}

function travelBearing(track: StationDepartureTrack): number {
  return departureBearing(track, up.value);
}

function boundaryAhead(track: StationDepartureTrack): number {
  return up.value ? track.upBoundaryAhead : track.downBoundaryAhead;
}

function continues(track: StationDepartureTrack): boolean {
  return up.value ? track.upContinues : track.downContinues;
}

function boundaryText(track: StationDepartureTrack): string {
  const ahead = boundaryAhead(track);
  if (ahead < 1) return continues(track) ? '出发点位于拓扑节点' : '出发方向没有接续';
  return `前方 ${Math.round(ahead)} m ${continues(track) ? '可接续' : '线路数据边界'}`;
}

function selectTrack(segmentId: string): void {
  selected.value = segmentId;
}

function confirm(): void {
  if (!active.value || props.busy) return;
  emit('depart', { track: active.value, up: up.value });
}

function onKeydown(event: KeyboardEvent): void {
  if (event.code === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

watch(selected, async () => {
  await nextTick();
  // Scroll only the track list, so a click on the diagram keeps the marked row visible.
  const list = listEl.value;
  const button = list?.querySelector<HTMLElement>(`[data-track-index="${activeIndex.value}"]`);
  if (!list || !button) return;
  if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop;
  else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight;
  }
});

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div class="modal-backdrop departure-backdrop">
    <section class="departure-dialog" role="dialog" aria-modal="true" aria-labelledby="departure-title">
      <header class="departure-header">
        <div>
          <p class="eyebrow">STATION DEPARTURE · 车站始发</p>
          <h2 id="departure-title">选择运行方向与始发股道</h2>
          <p class="departure-station">
            {{ departure.station.name }} <span>{{ departure.station.telecode }}</span> · {{ departure.station.province }} {{ departure.station.city }}
          </p>
        </div>
        <div class="departure-head-side">
          <div class="departure-head-status">
            <span class="departure-status-dot" />
            <span><b>{{ departure.tracks.length }}</b> 条可选股道</span>
          </div>
          <button class="departure-close" aria-label="返回重新选站" @click="$emit('close')">×</button>
        </div>
      </header>

      <div class="departure-body">
        <section class="departure-map-panel" aria-label="车站配线图面板">
          <div class="departure-section-head">
            <div>
              <h3>车站配线图</h3>
              <p>青色线为可选股道，灰色线为周边其它轨道；<br class="wide-only" />编号仅用于本界面选择，不是铁路官方股道号。</p>
            </div>
            <span class="departure-map-hint">点击线路选择</span>
          </div>

          <StationDepartureMap :departure="departure" :tracks="visibleTracks" :selected="selected" :up="up" @select="selectTrack" />

          <div class="departure-legend" aria-label="地图图例">
            <span><i class="legend-line nearby" />周边轨道</span>
            <span><i class="legend-line candidate" />可选股道</span>
            <span><i class="legend-line selected" />已选股道</span>
            <span><i class="legend-node" />车站</span>
            <span><i class="legend-arrow">↑</i>{{ up ? '上行' : '下行' }}方向</span>
          </div>
          <p class="departure-caption">底图仅作地理参考。相近股道在图上可能难以分辨，请使用右侧列表；本图不是联锁图，也不表示真实信号或股道占用。</p>
        </section>

        <aside class="departure-choice-panel" aria-label="方向与始发股道选择">
          <div class="departure-section-head">
            <div>
              <h3>01 / 运行方向</h3>
              <p>选择本次始发的上、下行方向，配线图箭头随之改变。</p>
            </div>
            <span class="departure-choice-count">{{ selectionCounter }}</span>
          </div>

          <div class="departure-direction" role="radiogroup" aria-label="运行方向">
            <button class="dir-button" :class="{ active: up }" role="radio" :aria-checked="up" @click="up = true">
              <span class="dir-title">上行 <b>↑</b></span>
              <span class="dir-compass">{{ upCompass }}</span>
              <small>推定朝向北京</small>
            </button>
            <button class="dir-button" :class="{ active: !up }" role="radio" :aria-checked="!up" @click="up = false">
              <span class="dir-title">下行 <b>↓</b></span>
              <span class="dir-compass">{{ downCompass }}</span>
              <small>与上行相反</small>
            </button>
          </div>
          <p class="departure-direction-note">行别按线路方位推定（朝北京为上行），只决定列车出发朝向，不代表真实行别、信号或调度。</p>

          <div class="departure-section-head departure-track-head">
            <div>
              <h3>02 / 始发股道</h3>
              <p>按距车站由近到远排列；列车将停在该股道距站最近点。</p>
            </div>
          </div>

          <div ref="listEl" class="departure-tracks">
            <button v-for="(track, index) in visibleTracks" :key="track.segmentId" :class="{ selected: selected === track.segmentId }" :data-track-index="index" :aria-pressed="selected === track.segmentId" @click="selectTrack(track.segmentId)">
              <span class="track-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="track-arrow" :style="{ transform: `rotate(${travelBearing(track)}deg)` }" aria-hidden="true">↑</span>
              <span class="track-copy">
                <span class="track-title"><strong>{{ displayName(track) }}</strong><em>{{ Math.round(track.segmentLength) }} m</em></span>
                <span class="track-meta">距站 {{ Math.round(track.distance) }} m · {{ boundaryText(track) }}<template v-if="track.bridge"> · 桥</template><template v-if="track.tunnel"> · 隧</template></span>
                <span v-if="!continues(track) && boundaryAhead(track) < 40" class="track-warning">该方向出发后立即遇到线路数据边界</span>
              </span>
              <span class="track-check" aria-hidden="true">{{ selected === track.segmentId ? '✓' : '›' }}</span>
            </button>
            <button v-if="remainingTracks > 0" class="departure-more" @click="visibleLimit += APP_CONFIG.stationDeparture.initialTracks">
              显示更多股道（还有 {{ remainingTracks }} 条）
            </button>
            <p v-if="departure.truncated" class="departure-truncated">仅列出距站最近的 {{ departure.tracks.length }} 条；如需其它位置，请返回使用地图选点。</p>
          </div>

          <div class="departure-footer">
            <p class="departure-selection" aria-live="polite">
              <template v-if="active"><span>已标记</span> <b>{{ String(activeIndex + 1).padStart(2, '0') }}</b> {{ displayName(active) }} · {{ up ? '上行' : '下行' }} {{ compassDirection(travelBearing(active)) }}</template>
              <template v-else>尚未选择，点击配线图青色线路或右侧股道</template>
            </p>
            <button class="departure-confirm" :disabled="!active || busy" @click="confirm">
              <span>{{ busy ? '正在进入驾驶…' : '从此股道始发' }}</span>
              <b>→</b>
            </button>
            <small class="departure-fine-print">确认后列车以驻车状态停在所选股道，距站中心 {{ active ? Math.round(active.distance) : '--' }} 米。</small>
          </div>
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
.departure-head-side { display: flex; flex-shrink: 0; align-items: center; gap: 10px; margin-top: 4px; }
.departure-head-status { display: flex; align-items: center; gap: 8px; padding: 8px 11px; border: 1px solid rgba(216, 255, 98, .23); color: #c5d3bd; background: rgba(216, 255, 98, .045); font-size: 10px; white-space: nowrap; }
.departure-head-status b { color: var(--accent); font-family: 'Barlow Condensed', sans-serif; font-size: 17px; font-weight: 600; }
.departure-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 9px rgba(216, 255, 98, .65); }
.departure-close { width: 34px; height: 34px; border: 1px solid var(--line); background: transparent; color: #b8bdb5; font-size: 22px; line-height: 1; }
.departure-close:hover { border-color: var(--accent); color: var(--accent); }
.departure-body { display: grid; flex: 1; grid-template-columns: minmax(0, 1.6fr) minmax(320px, .9fr); min-height: 0; }
.departure-map-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 16px 20px 13px; background: #0f1510; }
.departure-choice-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; padding: 16px 18px 15px; border-left: 1px solid var(--line); background: #151c16; }
.departure-section-head { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
.departure-section-head h3 { margin: 0; color: #e8efe2; font-size: 13px; font-weight: 600; letter-spacing: .2px; }
.departure-section-head p { margin: 4px 0 0; color: #8e9a89; font-size: 9px; line-height: 1.55; }
.departure-map-hint { flex-shrink: 0; padding: 4px 7px; border: 1px solid rgba(127, 221, 231, .25); color: #92e0e8; background: rgba(127, 221, 231, .05); font-size: 9px; white-space: nowrap; }
.departure-choice-count { flex-shrink: 0; margin-top: 1px; color: var(--accent); font-family: 'Barlow Condensed', sans-serif; font-size: 15px; letter-spacing: 1px; white-space: nowrap; }
.departure-map-panel .departure-map-host { flex: 1; min-height: 260px; }
.departure-legend { display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; gap: 7px 15px; margin-top: 9px; color: #9da99a; font-size: 9px; }
.departure-legend span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.departure-legend i { display: inline-block; flex-shrink: 0; }
.legend-line { width: 17px; height: 2px; border-radius: 2px; }
.legend-line.nearby { background: #aebda9; opacity: .55; }
.legend-line.candidate { background: #7fdde7; }
.legend-line.selected { height: 4px; background: var(--accent); box-shadow: 0 0 7px rgba(216, 255, 98, .5); }
.legend-node { width: 7px; height: 7px; border-radius: 50%; background: #f4f8ee; box-shadow: 0 0 0 2px rgba(216, 255, 98, .4); }
.legend-arrow { color: #d8ff62; font-size: 11px; font-style: normal; line-height: 1; }
.departure-caption { flex: 0 0 auto; margin: 7px 0 0; color: #778374; font-size: 9px; line-height: 1.55; }
.departure-direction { display: grid; flex: 0 0 auto; grid-template-columns: 1fr 1fr; gap: 8px; }
.dir-button { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 2px 8px; padding: 10px 12px; border: 1px solid rgba(255, 255, 255, .13); background: #1a211b; text-align: left; transition: border-color .15s, background .15s, box-shadow .15s; }
.dir-button:hover { border-color: rgba(216, 255, 98, .5); }
.dir-button.active { border-color: var(--accent); background: rgba(216, 255, 98, .1); box-shadow: inset 3px 0 var(--accent); }
.dir-title { color: #eef4e8; font-size: 13px; font-weight: 600; letter-spacing: 1px; }
.dir-title b { margin-left: 2px; color: #8b987f; font-size: 14px; font-weight: 400; }
.dir-button.active .dir-title b { color: var(--accent); }
.dir-compass { color: #d8ff62; font-family: 'Barlow Condensed', sans-serif; font-size: 19px; line-height: 1; }
.dir-button small { grid-column: 1 / -1; color: #8d9b88; font-size: 8.5px; }
.departure-direction-note { flex: 0 0 auto; margin: 7px 0 0; color: #7d8979; font-size: 8.5px; line-height: 1.55; }
.departure-track-head { margin-top: 13px; margin-bottom: 7px; }
.departure-tracks { position: relative; flex: 1; min-height: 0; padding-right: 4px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #465243 transparent; }
.departure-tracks > button { display: grid; grid-template-columns: 26px 22px minmax(0, 1fr) 18px; gap: 8px; align-items: center; width: 100%; margin-top: 6px; padding: 9px 10px; border: 1px solid rgba(255, 255, 255, .11); background: #1a211b; text-align: left; transition: border-color .15s, background .15s, box-shadow .15s; }
.departure-tracks > button:first-child { margin-top: 0; }
.departure-tracks > button:hover { border-color: rgba(216, 255, 98, .55); background: rgba(216, 255, 98, .055); }
.departure-tracks > button.selected { border-color: var(--accent); background: rgba(216, 255, 98, .105); box-shadow: inset 3px 0 var(--accent); }
.track-index { align-self: start; margin-top: 2px; color: #7f8c7b; font-family: 'Barlow Condensed', monospace; font-size: 11px; letter-spacing: 1px; }
.departure-tracks > button.selected .track-index { color: var(--accent); }
.track-arrow { display: inline-block; color: var(--accent); font-size: 19px; line-height: 1; text-align: center; transform-origin: center; }
.track-copy { display: block; min-width: 0; }
.track-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.track-title strong { display: block; min-width: 0; color: #eef4e8; font-size: 11px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.track-title em { flex-shrink: 0; color: #8d9b88; font-family: 'Barlow Condensed', sans-serif; font-size: 9px; font-style: normal; letter-spacing: .5px; }
.track-meta { display: block; margin-top: 3px; color: #8c9988; font-size: 9px; line-height: 1.5; }
.track-warning { display: block; margin-top: 4px; color: #ffc06a; font-size: 9px; line-height: 1.5; }
.track-check { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid rgba(255, 255, 255, .12); color: #7f8b7a; font-size: 13px; }
.departure-tracks > button.selected .track-check { border-color: var(--accent); color: #111710; background: var(--accent); font-size: 11px; font-weight: 700; }
.departure-more { margin-top: 7px !important; border-style: dashed !important; color: #b9c6b2 !important; background: transparent !important; font-size: 10px !important; text-align: center !important; }
.departure-more:hover { border-color: var(--accent) !important; color: var(--accent) !important; }
.departure-truncated { margin: 7px 0 0; color: #7d8979; font-size: 8.5px; line-height: 1.5; }
.departure-footer { flex: 0 0 auto; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
.departure-selection { min-height: 18px; margin: 0 0 8px; color: #9aa796; font-size: 10px; line-height: 1.5; }
.departure-selection b { color: var(--accent); font-family: 'Barlow Condensed', sans-serif; font-size: 13px; }
.departure-selection span { color: #7f8c7b; }
.departure-confirm { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 46px; padding: 0 15px; border: 1px solid var(--accent); color: #111710; background: var(--accent); font-size: 12px; font-weight: 700; }
.departure-confirm:not(:disabled):hover { background: #e4ff90; }
.departure-confirm:disabled { color: #a1aa9d; border-color: rgba(255, 255, 255, .13); background: #222a23; opacity: 1; }
.departure-confirm b { font-size: 18px; font-weight: 400; }
.departure-fine-print { display: block; margin-top: 8px; color: #7d8979; font-size: 8.5px; line-height: 1.6; }
@media (max-width: 940px) {
  .departure-dialog { width: calc(100vw - 24px); height: auto; max-height: 94vh; overflow-y: auto; }
  .departure-body { display: flex; flex: 0 0 auto; flex-direction: column; }
  .departure-map-panel { flex: 0 0 auto; padding: 14px 16px 12px; }
  .departure-map-panel .departure-map-host { flex: 0 0 360px; height: 360px; min-height: 360px; }
  .departure-choice-panel { flex: 0 0 auto; border-top: 1px solid var(--line); border-left: 0; padding: 14px 16px 16px; }
  .departure-tracks { flex: 0 0 auto; max-height: 320px; }
}
@media (max-width: 620px) {
  .departure-backdrop { padding: 8px; }
  .departure-dialog { width: 100%; max-height: calc(100dvh - 16px); }
  .departure-header { flex-direction: column; gap: 10px; padding: 14px 14px 12px; }
  .departure-dialog h2 { font-size: 20px; }
  .departure-head-side { width: 100%; justify-content: space-between; }
  .departure-map-panel { padding: 12px 12px 10px; }
  .departure-map-panel .departure-map-host { flex-basis: 270px; height: 270px; min-height: 250px; }
  .departure-choice-panel { padding: 12px 12px 14px; }
  .departure-caption { display: none; }
  .departure-header { padding: 12px 14px 10px; }
  .departure-section-head { gap: 10px; }
  .departure-section-head p { max-width: 290px; }
  .departure-map-hint { display: none; }
  .departure-legend { gap: 6px 11px; }
  .departure-tracks > button { grid-template-columns: 24px minmax(0, 1fr) 18px; }
  .track-arrow { display: none; }
  .track-title { align-items: flex-start; }
  .departure-direction-note { font-size: 8px; }
  .wide-only { display: none; }
}
</style>
