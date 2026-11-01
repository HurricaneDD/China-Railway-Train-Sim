<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import DrivingHud from './components/DrivingHud.vue';
import JunctionDialog from './components/JunctionDialog.vue';
import MapView from './components/MapView.vue';
import NewGamePanel from './components/NewGamePanel.vue';
import SavePanel from './components/SavePanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StartMenu from './components/StartMenu.vue';
import { APP_CONFIG, type GameSettings } from './config';
import { HornAudio } from './core/audio';
import { GameSession } from './core/session';
import { loadSettings, saveSettings, saveStore, validateGameSave } from './core/storage';
import type { CesiumMap } from './map/CesiumMap';
import type { GameSave, LonLat, Reverser, Station } from './types';
import { distance } from './utils/geo';

const session = new GameSession();
const horn = new HornAudio();
const screen = ref<'menu' | 'new' | 'driving'>('menu');
const overlay = ref<'saves' | 'settings' | null>(null);
// Cesium maintains identity-sensitive object graphs; keep them outside deep reactivity.
const map = shallowRef<CesiumMap>();
const cameraMode = ref<'cab' | 'external'>('cab');
const mapReady = ref(false);
const dataReady = ref(false);
const busy = ref(false);
const hasSave = ref(false);
const saves = ref<GameSave[]>([]);
const settings = ref<GameSettings>(loadSettings());
const selectedProvince = ref('');
const selectingMap = ref(false);
const updateKey = ref(0);
const toastMessage = ref('');
const toastKind = ref<'info' | 'error'>('info');
let toastTimer = 0;
let lastRenderPoint: LonLat | undefined;
let renderingTrack = false;
const ready = computed(() => mapReady.value && dataReady.value);

session.onUpdate = () => {
  updateKey.value++;
  const point = session.currentPoint();
  if (screen.value === 'driving' && point && (!lastRenderPoint || distance(point, lastRenderPoint) > 2500)) void maybeRenderTrack(point);
};
session.onError = (message) => notify(message, true);
session.onAutosave = () => { if (settings.value.autosave) void autoSave(); };
horn.enabled = settings.value.sound;

onMounted(async () => {
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  window.addEventListener('pointerup', releaseControls);
  document.addEventListener('visibilitychange', visibilityChanged);
  try {
    await session.initialize();
    dataReady.value = true;
    await refreshSaves();
  } catch (error) {
    notify(error instanceof Error ? error.message : '基础数据加载失败', true);
  }
});

onBeforeUnmount(() => {
  session.stop();
  horn.stop();
  window.removeEventListener('keydown', keyDown);
  window.removeEventListener('keyup', keyUp);
  window.removeEventListener('pointerup', releaseControls);
  document.removeEventListener('visibilitychange', visibilityChanged);
});

function notify(message: string, error = false): void {
  toastMessage.value = message;
  toastKind.value = error ? 'error' : 'info';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { toastMessage.value = ''; }, error ? 6000 : 3200);
}

async function refreshSaves(): Promise<void> {
  try {
    saves.value = await saveStore.list();
    hasSave.value = saves.value.length > 0;
  } catch {
    notify('浏览器本地存档不可用，请检查隐私或存储设置', true);
  }
}

async function continueGame(): Promise<void> {
  const save = await saveStore.latest();
  if (!save) return notify('没有有效存档，请开始新游戏', true);
  await loadSave(save);
}

async function loadSave(save: GameSave): Promise<void> {
  busy.value = true;
  try {
    await session.restore(save);
    selectedProvince.value = save.position.province;
    overlay.value = null;
    screen.value = 'driving';
    map.value?.clearStations();
    map.value?.setPicking();
    map.value?.setCameraRange(settings.value.cameraRange);
    await renderCurrentRailway();
    notify(`已恢复「${save.name}」`);
  } catch (error) {
    notify(error instanceof Error ? error.message : '存档恢复失败', true);
  } finally {
    busy.value = false;
  }
}

async function selectProvince(name: string): Promise<void> {
  if (busy.value) return;
  selectedProvince.value = name;
  selectingMap.value = false;
  busy.value = true;
  try {
    await session.railway.load(name);
    const provinceStations = session.stations.stations.filter((station) => station.province === name);
    map.value?.showStations(provinceStations);
    if (provinceStations.length) {
      const center = provinceStations.reduce((acc, station) => ({ lon: acc.lon + station.longitude / provinceStations.length, lat: acc.lat + station.latitude / provinceStations.length }), { lon: 0, lat: 0 });
      map.value?.flyTo(center);
      await map.value?.renderRailway(session.railway.network.segmentsNear(center, settings.value.renderRadius));
    } else {
      notify('该省份没有带坐标车站，可在已有线路区域直接选点');
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : '线路加载失败', true);
  } finally {
    busy.value = false;
  }
}

function enableMapSelection(): void {
  selectingMap.value = true;
  map.value?.setPicking(startMapLocation, (code) => {
    const station = session.stations.byCode(code);
    if (station) void startStation(station);
  });
  notify('请点击地图上的铁路附近位置');
}

async function startMapLocation(point: LonLat): Promise<void> {
  if (!selectingMap.value || !selectedProvince.value || busy.value) return;
  busy.value = true;
  try {
    const snapped = await session.startAt(selectedProvince.value, point, APP_CONFIG.data.mapSnapDistance);
    await beginDriving(snapped.position);
  } catch (error) {
    notify(error instanceof Error ? error.message : '无法吸附到铁路', true);
  } finally {
    busy.value = false;
  }
}

async function startStation(station: Station): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  selectedProvince.value = station.province;
  try {
    const snapped = await session.startAt(station.province, { lon: station.longitude, lat: station.latitude }, APP_CONFIG.data.stationSnapDistance);
    await beginDriving(snapped.position);
    notify(`已从${station.full_name}出发 · 吸附偏差 ${snapped.distance.toFixed(0)} m`);
  } catch (error) {
    notify(error instanceof Error ? error.message : '车站关联铁路失败', true);
  } finally {
    busy.value = false;
  }
}

async function beginDriving(point: LonLat): Promise<void> {
  screen.value = 'driving';
  overlay.value = null;
  selectingMap.value = false;
  map.value?.setPicking();
  map.value?.clearStations();
  map.value?.setCameraRange(settings.value.cameraRange);
  lastRenderPoint = point;
  await map.value?.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius));
  await refreshSaves();
}

async function renderCurrentRailway(): Promise<void> {
  const point = session.currentPoint();
  if (point && map.value) {
    lastRenderPoint = point;
    await map.value.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius));
  }
}

async function maybeRenderTrack(point: LonLat): Promise<void> {
  if (renderingTrack || !map.value) return;
  renderingTrack = true;
  lastRenderPoint = point;
  try {
    await map.value.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius));
  } catch {
    notify('前方轨道显示更新失败，列车驾驶不受影响', true);
  } finally {
    renderingTrack = false;
  }
}

async function autoSave(): Promise<void> {
  if (!session.running || !session.position) return;
  try {
    await saveStore.put(session.createSave('自动存档', 'autosave'));
    await refreshSaves();
  } catch {
    notify('自动保存失败，请使用存档管理导出备份', true);
  }
}

async function quickSave(): Promise<void> {
  busy.value = true;
  try {
    const save = await session.manualSave(`手动存档 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    await refreshSaves();
    notify(`已保存「${save.name}」`);
  } catch (error) {
    notify(error instanceof Error ? error.message : '保存失败', true);
  } finally {
    busy.value = false;
  }
}

async function namedSave(name: string): Promise<void> {
  if (!session.running) return;
  try {
    await session.manualSave(name);
    await refreshSaves();
    notify('当前进度已保存');
  } catch (error) {
    notify(error instanceof Error ? error.message : '保存失败', true);
  }
}

async function deleteSave(save: GameSave): Promise<void> {
  if (!window.confirm(`确定删除「${save.name}」吗？此操作不可撤销。`)) return;
  try {
    await saveStore.delete(save.id);
    await refreshSaves();
  } catch (error) {
    notify(error instanceof Error ? error.message : '删除失败', true);
  }
}

function exportSave(save: GameSave): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `CRTS-${save.name.replace(/[\\/:*?"<>|]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function importSave(file: File): Promise<void> {
  try {
    const value: unknown = JSON.parse(await file.text());
    if (!validateGameSave(value)) throw new Error('文件不是受支持的 V1 存档，必要字段缺失或格式无效');
    await saveStore.put(value);
    await refreshSaves();
    notify('存档导入成功');
  } catch (error) {
    notify(error instanceof Error ? error.message : '存档导入失败', true);
  }
}

async function openOverlay(value: 'saves' | 'settings'): Promise<void> {
  if (value === 'saves') await refreshSaves();
  overlay.value = value;
}

async function returnMenu(): Promise<void> {
  if (settings.value.autosave) await autoSave();
  session.stop();
  horn.stop();
  screen.value = 'menu';
  overlay.value = null;
  map.value?.setPicking();
  await refreshSaves();
}

function changeSettings(value: GameSettings): void {
  settings.value = value;
  horn.enabled = value.sound;
  saveSettings(value);
  map.value?.setCameraRange(value.cameraRange);
}

function changeReverser(value: Reverser): void {
  if (!session.setReverser(value)) notify('列车尚未停稳，速度不超过 0.5 km/h 才能换向', true);
}

function toggleCamera(): void {
  cameraMode.value = cameraMode.value === 'cab' ? 'external' : 'cab';
  map.value?.setCameraMode(cameraMode.value);
}

function triggerSand(): void {
  notify(session.sand() ? '撒砂已启用，黏着系数暂时提高' : '当前没有黏着不足，无需撒砂');
}

function keyDown(event: KeyboardEvent): void {
  if (screen.value !== 'driving' || overlay.value || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) return;
  if (['Shift', 'Control', 'Space'].includes(event.code)) event.preventDefault();
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
    if (!event.repeat) session.setThrottle(session.train.throttle + APP_CONFIG.train.throttleStep);
    session.holdThrottle('up', true);
  }
  if (event.code === 'ControlLeft' || event.code === 'ControlRight') {
    if (!event.repeat) session.setThrottle(session.train.throttle - APP_CONFIG.train.throttleStep);
    session.holdThrottle('down', true);
  }
  if (event.code === 'Space') session.brakeHeld = true;
  if (event.code === 'KeyH' && !event.repeat) void horn.start();
  if (event.code === 'KeyX' && !event.repeat) triggerSand();
}

function keyUp(event: KeyboardEvent): void {
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') session.holdThrottle('up', false);
  if (event.code === 'ControlLeft' || event.code === 'ControlRight') session.holdThrottle('down', false);
  if (event.code === 'Space') session.brakeHeld = false;
  if (event.code === 'KeyH') horn.stop();
}

function releaseControls(): void {
  session.brakeHeld = false;
  horn.stop();
}

function visibilityChanged(): void {
  if (document.hidden && settings.value.autosave) void autoSave();
}
</script>

<template>
  <div class="app-shell" :class="{ 'is-driving': screen === 'driving' }">
    <MapView :session="session" @ready="map = $event; mapReady = true" @error="notify($event, true)" />
    <div v-if="screen !== 'driving'" class="map-shade" />
    <StartMenu v-if="screen === 'menu'" :has-save="hasSave" :ready="ready" @continue="continueGame" @new="screen = 'new'" @saves="openOverlay('saves')" @settings="openOverlay('settings')" />
    <div v-else-if="screen === 'new'" class="workspace">
      <div class="workspace-backdrop" @click="screen = 'menu'" />
      <NewGamePanel :stations="session.stations" :provinces="session.railway.provinces" :selected-province="selectedProvince" :busy="busy" @close="screen = 'menu'" @province="selectProvince" @station="startStation" @location="enableMapSelection" />
      <div v-if="selectingMap" class="map-select-banner"><span class="pulse" />地图选点已启用 · 点击铁路附近位置<button @click="selectingMap = false; map?.setPicking()">取消</button></div>
    </div>
    <DrivingHud v-else :session="session" :update-key="updateKey" :camera-range="settings.cameraRange" :camera-mode="cameraMode" @view="toggleCamera" @menu="returnMenu" @save="quickSave" @settings="openOverlay('settings')" @reverser="changeReverser" @horn="(held) => held ? horn.start() : horn.stop()" @sand="triggerSand" @camera="(range) => { map?.setCameraRange(range); settings.cameraRange = Math.max(35, Math.min(900, range)); }" />
    <JunctionDialog v-if="session.junction" :junction="session.junction" @choose="session.chooseJunction" />
    <div v-if="overlay" class="modal-backdrop" @click.self="overlay = null">
      <SavePanel v-if="overlay === 'saves'" :saves="saves" :busy="busy" :in-game="session.running" @close="overlay = null" @load="loadSave" @delete="deleteSave" @save="namedSave" @export="exportSave" @import="importSave" />
      <SettingsPanel v-else :settings="settings" @close="overlay = null" @change="changeSettings" />
    </div>
    <div v-if="busy" class="loading-indicator"><span class="spinner" />正在处理线路数据</div>
    <div v-if="toastMessage" class="toast" :class="toastKind" role="status">{{ toastMessage }}<button @click="toastMessage = ''">×</button></div>
  </div>
</template>
