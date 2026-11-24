<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import DrivingHud from './components/DrivingHud.vue';
import HomeBackdrop from './components/HomeBackdrop.vue';
import JunctionDialog from './components/JunctionDialog.vue';
import MapView from './components/MapView.vue';
import NewGamePanel from './components/NewGamePanel.vue';
import SavePanel from './components/SavePanel.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import StartMenu from './components/StartMenu.vue';
import StationDepartureDialog from './components/StationDepartureDialog.vue';
import { APP_CONFIG, type GameSettings } from './config';
import { HornAudio } from './core/audio';
import { GameSession } from './core/session';
import { loadSettings, saveSettings, saveStore, validateGameSave } from './core/storage';
import { buildStationDeparture, lineBearing } from './data/stationDeparture';
import type { ProvinceLoadProgress } from './data/railway';
import type { CesiumMap } from './map/CesiumMap';
import type { CameraMode, GameSave, LonLat, Reverser, Station, StationDeparture, StationDepartureLine } from './types';
import { compassDirection, distance } from './utils/geo';

const session = new GameSession();
const horn = new HornAudio();
const screen = ref<'menu' | 'new' | 'driving'>('menu');
const overlay = ref<'saves' | 'settings' | null>(null);
// Cesium maintains identity-sensitive object graphs; keep them outside deep reactivity.
const map = shallowRef<CesiumMap>();
const cameraMode = ref<CameraMode>('cab');
const mapReady = ref(false);
const dataReady = ref(false);
const mapStatus = ref('');
const busy = ref(false);
const hasSave = ref(false);
const saves = ref<GameSave[]>([]);
const settings = ref<GameSettings>(loadSettings());
const selectedProvince = ref('');
interface ProvinceLoadingState { province: string; percent: number; detail: string }
const provinceLoading = ref<ProvinceLoadingState | null>(null);

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '未知';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function provinceProgressPercent(progress: ProvinceLoadProgress): number {
  if (progress.phase === 'download') return 2 + Math.min(1, progress.ratio) * 74;
  if (progress.phase === 'parse') return 76 + Math.min(1, progress.ratio) * 20;
  return 97;
}

function provinceProgressDetail(progress: ProvinceLoadProgress): string {
  if (progress.phase === 'download') {
    return `正在下载线路数据 · ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}`;
  }
  if (progress.phase === 'parse') {
    if (!progress.featuresTotal) return '正在解析线路几何';
    const done = (progress.featuresDone ?? 0).toLocaleString('zh-CN');
    const total = progress.featuresTotal.toLocaleString('zh-CN');
    return `正在解析线路几何 · ${done} / ${total} 条`;
  }
  return '线路数据已就绪，正在准备地图预览';
}
const selectingMap = ref(false);
const departure = ref<StationDeparture | null>(null);
const userPaused = ref(false);
const showHelp = ref(false);
const dataError = ref('');
watch([userPaused, overlay, showHelp, busy, screen], () => {
  if (screen.value === 'driving') session.setPaused(userPaused.value || !!overlay.value || showHelp.value || busy.value);
});
const updateKey = ref(0);
const toastMessage = ref('');
const toastKind = ref<'info' | 'error'>('info');
let toastTimer = 0;
let lastRenderPoint: LonLat | undefined;
let renderingTrack = false;
const ready = computed(() => mapReady.value && dataReady.value);
const backgroundHint = computed(() =>
  ready.value && mapStatus.value.startsWith('正在加载') ? '地图瓦片与地形后台加载中' : '',
);

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
  window.addEventListener('blur', releaseFocusInputs);
  document.addEventListener('visibilitychange', visibilityChanged);
  try {
    await session.initialize();
    dataReady.value = true;
    await refreshSaves();
  } catch (error) {
    dataError.value = error instanceof Error ? error.message : '基础数据加载失败';
    notify(dataError.value, true);
  }
});

onBeforeUnmount(() => {
  session.stop();
  horn.stop();
  window.removeEventListener('keydown', keyDown);
  window.removeEventListener('keyup', keyUp);
  window.removeEventListener('pointerup', releaseControls);
  window.removeEventListener('blur', releaseFocusInputs);
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
    userPaused.value = true;
    showHelp.value = false;
    screen.value = 'driving';
    session.setPaused(true);
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

async function newGame(): Promise<void> {
  // Clear any leftover modal state from a previous attempt before leaving the menu.
  departure.value = null;
  overlay.value = null;
  selectingMap.value = false;
  showHelp.value = false;
  screen.value = 'new';
  // 开始游戏先进入省份选择，不再默认加载任何省份；选中后才进入该省地图预览。
  resetProvinceView();
}

/** 回到省份选择步骤：清理上一省的预览图、车站圆点和地图点选回调，恢复全国视角。 */
function resetProvinceView(): void {
  selectedProvince.value = '';
  selectingMap.value = false;
  map.value?.setPicking();
  map.value?.clearStations();
  map.value?.clearRailway();
  map.value?.flyTo({ lon: 108, lat: 34 }, 10_500_000);
}

/** 预览面板“更换省份”按钮：退回第一步重新点选省份。 */
function resetProvince(): void {
  if (busy.value) return;
  resetProvinceView();
}

async function selectProvince(name: string): Promise<void> {
  if (busy.value || !name) return;
  busy.value = true;
  provinceLoading.value = { province: name, percent: 0, detail: '正在准备线路数据' };
  try {
    await session.railway.load(name, (progress) => {
      provinceLoading.value = { province: name, percent: provinceProgressPercent(progress), detail: provinceProgressDetail(progress) };
    });
    const provinceStations = session.stations.stations.filter((station) => station.province === name);
    provinceLoading.value = { province: name, percent: 99, detail: `正在载入 ${provinceStations.length} 个有坐标车站并绘制预览` };
    // 数据加载成功后才切换到预览步骤；失败时停留在省份选择，便于重试。
    selectedProvince.value = name;
    selectingMap.value = false;
    map.value?.showStations(provinceStations);
    const segments = [...session.railway.network.segments.values()].filter((segment) => segment.properties.province === name);
    map.value?.showProvinceRailway(segments);
    armProvincePicking();
    await nextTick();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    provinceLoading.value = { province: name, percent: 100, detail: '加载完成，正在进入省份地图预览' };
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
    if (!provinceStations.length) {
      notify('该省份没有带坐标车站，可在已有线路区域直接选点');
    }
  } catch (error) {
    notify(error instanceof Error ? error.message : '线路加载失败', true);
  } finally {
    provinceLoading.value = null;
    busy.value = false;
  }
}

/** 省份预览期间地图点选保持可用：点铁路附近位置吸附出发，点车站圆点打开车站线路图。 */
function armProvincePicking(): void {
  if (screen.value !== 'new' || !selectedProvince.value) return;
  map.value?.setPicking(startMapLocation, (code) => {
    const station = session.stations.byCode(code);
    if (station) void startStation(station);
  });
}

function enableMapSelection(): void {
  if (!selectedProvince.value || busy.value) return;
  selectingMap.value = true;
  armProvincePicking();
  notify('请点击地图上的铁路附近位置');
}

async function startMapLocation(point: LonLat): Promise<void> {
  // 省份预览（面板或全屏选点横幅）中点击地图均可吸附出发；驾驶与菜单阶段忽略。
  if (screen.value !== 'new' || !selectedProvince.value || busy.value) return;
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
    // Only local geometry: never trigger a whole-network topology build here.
    await session.railway.load(station.province);
    const snapshot = buildStationDeparture(session.railway.network, station);
    if (!snapshot.lines.length) {
      notify(`${station.name}站周边没有可识别的国铁线路，请改用地图选点`, true);
      armProvincePicking();
      return;
    }
    selectingMap.value = false;
    // 车站线路图打开期间暂停地图点选，关闭后由 closeDeparture 重新启用。
    map.value?.setPicking();
    departure.value = snapshot;
  } catch (error) {
    notify(error instanceof Error ? error.message : '车站线路图读取失败', true);
    armProvincePicking();
  } finally {
    busy.value = false;
  }
}

/** 关闭车站线路图后回到省份预览，恢复地图点选与车站圆点点击。 */
function closeDeparture(): void {
  departure.value = null;
  armProvincePicking();
}

async function departFromStation(payload: { line: StationDepartureLine; direction: 1 | -1 }): Promise<void> {
  if (busy.value) return;
  const station = departure.value?.station;
  busy.value = true;
  try {
    const bearing = lineBearing(payload.line, payload.direction);
    const point = session.startOnTrack(payload.line.segmentId, payload.line.offset, payload.direction);
    departure.value = null;
    if (station) notify(`已从${station.full_name}出发 · 向${compassDirection(bearing)}`);
    await beginDriving(point);
  } catch (error) {
    notify(error instanceof Error ? error.message : '无法从所选线路出发', true);
  } finally {
    busy.value = false;
  }
}

async function beginDriving(point: LonLat): Promise<void> {
  setCameraMode('cab');
  userPaused.value = false;
  showHelp.value = true;
  screen.value = 'driving';
  session.setPaused(true);
  overlay.value = null;
  selectingMap.value = false;
  map.value?.setPicking();
  map.value?.clearStations();
  map.value?.setCameraRange(settings.value.cameraRange);
  lastRenderPoint = point;
  await map.value?.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius, APP_CONFIG.data.maxRenderSegments, session.position?.segmentId));
  await refreshSaves();
}

async function renderCurrentRailway(): Promise<void> {
  const point = session.currentPoint();
  if (point && map.value) {
    lastRenderPoint = point;
    await map.value.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius, APP_CONFIG.data.maxRenderSegments, session.position?.segmentId));
  }
}

async function maybeRenderTrack(point: LonLat): Promise<void> {
  if (renderingTrack || !map.value) return;
  renderingTrack = true;
  lastRenderPoint = point;
  try {
    await map.value.renderRailway(session.railway.network.segmentsNear(point, settings.value.renderRadius, APP_CONFIG.data.maxRenderSegments, session.position?.segmentId));
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
    const imported = await saveStore.import(value);
    await refreshSaves();
    notify(imported.id === value.id ? '存档导入成功' : '同名 ID 已另存为副本，原存档已保留');
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
  userPaused.value = false;
  showHelp.value = false;
  screen.value = 'menu';
  overlay.value = null;
  map.value?.setPicking();
  map.value?.clearStations();
  await refreshSaves();
}

function changeSettings(value: GameSettings): void {
  if (value.mapTiles !== settings.value.mapTiles) map.value?.setMapTiles(value.mapTiles);
  settings.value = value;
  horn.enabled = value.sound;
  saveSettings(value);
  map.value?.setCameraRange(value.cameraRange);
}

function changeReverser(value: Reverser): void {
  if (!session.setReverser(value)) notify('列车尚未停稳，速度不超过 0.5 km/h 才能换向', true);
}

function setCameraMode(mode: CameraMode): void {
  cameraMode.value = mode;
  map.value?.setCameraMode(mode);
}

function triggerSand(): void {
  notify(session.sand() ? '撒砂已启用，黏着系数暂时提高' : '当前没有黏着不足，无需撒砂');
}

function keyDown(event: KeyboardEvent): void {
  if (screen.value === 'driving' && !overlay.value && !showHelp.value && ['Escape', 'KeyP'].includes(event.code) && !(event.target instanceof HTMLInputElement)) {
    event.preventDefault();
    if (!event.repeat) userPaused.value = !userPaused.value;
    return;
  }
  if (session.paused || session.junction) return;
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

/**
 * 失焦或切后台只释放可能卡住的按键/鸣笛，不暂停驾驶。
 * 浏览器在标签页隐藏时会暂停 requestAnimationFrame，列车实际停在原处；
 * 返回页面后按最大帧差 100 ms 继续，不补算后台时间。
 */
function releaseFocusInputs(): void {
  session.clearControls();
  horn.stop();
}

function visibilityChanged(): void {
  if (!document.hidden) return;
  releaseFocusInputs();
  if (settings.value.autosave) void autoSave();
}

async function retryData(): Promise<void> {
  dataError.value = '';
  try { await session.initialize(); dataReady.value = true; }
  catch (error) { dataError.value = error instanceof Error ? error.message : '基础数据加载失败'; }
}

</script>

<template>
  <div class="app-shell" :class="{ 'is-driving': screen === 'driving', 'is-cab': cameraMode === 'cab' }">
    <!-- Cesium stays mounted behind the landing page so imagery and terrain keep loading. -->
    <MapView :session="session" :hide-loading-status="screen === 'menu'" :map-tiles="settings.mapTiles" @ready="map = $event; mapReady = true" @status="mapStatus = $event" @error="notify($event, true); userPaused = true" />
    <div v-if="screen === 'new'" class="map-shade" />
    <HomeBackdrop v-if="screen === 'menu'" />
    <StartMenu v-if="screen === 'menu'" :has-save="hasSave" :ready="ready" :background-hint="backgroundHint" @continue="continueGame" @new="newGame" @saves="openOverlay('saves')" @settings="openOverlay('settings')" />
    <div v-else-if="screen === 'new'" class="workspace">

      <NewGamePanel v-if="!selectingMap" :stations="session.stations" :provinces="session.railway.provinces" :selected-province="selectedProvince" :busy="busy" @close="screen = 'menu'" @province="selectProvince" @reset-province="resetProvince" @station="startStation" @location="enableMapSelection" />
      <div v-if="selectingMap" class="map-select-banner"><span class="pulse" />地图选点已启用 · 点击铁路附近位置或车站圆点<button @click="selectingMap = false">返回省份预览</button></div>
    </div>
    <DrivingHud v-else :session="session" :update-key="updateKey" :camera-range="settings.cameraRange" :camera-mode="cameraMode" :paused="userPaused" @view="setCameraMode" @pause="userPaused = !userPaused" @help="showHelp = true" @parking="session.toggleParkingBrake()" @retry="session.retryBorder()" @menu="returnMenu" @save="quickSave" @saves="openOverlay('saves')" @settings="openOverlay('settings')" @reverser="changeReverser" @horn="(held) => held ? horn.start() : horn.stop()" @sand="triggerSand" @camera="(range) => { map?.setCameraRange(range); settings.cameraRange = Math.max(35, Math.min(900, range)); }" @speed="session.setSimulationSpeed($event)" />
    <StationDepartureDialog v-if="departure" :departure="departure" :busy="busy" @close="closeDeparture" @depart="departFromStation" />
    <JunctionDialog v-if="session.junction && !showHelp && !userPaused && !overlay" :junction="session.junction" @choose="(id) => session.chooseJunction(id)" />
    <div v-if="screen === 'driving' && showHelp" class="modal-backdrop">
      <section class="panel help-panel" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <p class="eyebrow">FREE DRIVE / 全国自由驾驶 DEMO</p>
        <h2 id="help-title">从这里，开出第一公里</h2>
        <p>列车已驻车，所有省份均可自由出发。先熟悉操纵，再沿真实铁路探索。</p>
        <ol class="drive-steps">
          <li><b>01 · 起步</b><span>松开驻车，按 Shift 或拖动牵引手柄，逐步增加牵引。</span></li>
          <li><b>02 · 滑行与停车</b><span>Ctrl 降低牵引。按住空格约 4 秒施加全部制动，松开后约 4 秒缓解；停稳后可启用驻车。</span></li>
          <li><b>03 · 选择方向</b><span>分岔处会暂停，选择后继续。倒车需先停稳；P / Esc 随时暂停。</span></li>
        </ol>
        <p class="fine-print">可选练习：累计行驶 1 km 后停稳。自由驾驶不受练习限制；上一最近站为正在远离的最近车站，下一最近站为正在接近的最近车站；距离为直线距离，每秒更新，停车沿用最近行进方向（初始按换向器方向）。人工检查线路时可使用 2× / 5× / 10× / 20× / 30× / 50× 模拟速度，遇到分岔或线路中断仍会自动暂停。</p>
        <button class="button button-primary full-width" @click="showHelp = false">进入驾驶</button>
      </section>
    </div>
    <div v-else-if="screen === 'driving' && userPaused && !overlay" class="pause-strip" role="status">
      <strong>驾驶已暂停</strong><span>位置与速度已保留</span><button class="button button-primary" @click="userPaused = false">继续驾驶</button>
      <button class="button button-ghost" @click="showHelp = true">操作说明</button>
    </div>
    <div v-if="dataError" class="data-error" role="alert">{{ dataError }}<button @click="retryData">重试加载</button></div>
    <div v-if="overlay" class="modal-backdrop" @click.self="overlay = null">
      <SavePanel v-if="overlay === 'saves'" :saves="saves" :busy="busy" :in-game="session.running" @close="overlay = null" @load="loadSave" @delete="deleteSave" @save="namedSave" @export="exportSave" @import="importSave" />
      <SettingsPanel v-else :settings="settings" @close="overlay = null" @change="changeSettings" />
    </div>
    <div v-if="busy && !provinceLoading" class="loading-indicator"><span class="spinner" />正在处理线路数据</div>
    <div v-if="provinceLoading" class="province-loading" role="status" aria-live="polite" aria-busy="true">
      <section class="province-loading-card">
        <p class="eyebrow">PROVINCE DATA · 省份数据</p>
        <h2>正在加载线路和车站数据…</h2>
        <p class="province-loading-province">{{ provinceLoading.province }}</p>
        <div class="province-loading-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="Math.round(provinceLoading.percent)" :aria-valuetext="provinceLoading.detail">
          <div class="province-loading-fill" :style="{ width: `${Math.max(2, provinceLoading.percent)}%` }" />
        </div>
        <div class="province-loading-meta"><span>{{ provinceLoading.detail }}</span><b>{{ Math.round(provinceLoading.percent) }}%</b></div>
      </section>
    </div>
    <div v-if="toastMessage" class="toast" :class="toastKind" role="status">{{ toastMessage }}<button @click="toastMessage = ''">×</button></div>
  </div>
</template>
