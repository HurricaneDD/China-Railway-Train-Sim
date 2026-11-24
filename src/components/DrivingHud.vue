<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { APP_CONFIG } from '../config';
import type { GameSession } from '../core/session';
import type { CameraMode, Reverser } from '../types';

const props = defineProps<{ session: GameSession; updateKey: number; cameraRange: number; cameraMode: CameraMode; paused: boolean }>();
const emit = defineEmits<{
  menu: []; save: []; saves: []; settings: []; help: []; pause: []; retry: []; parking: [];
  reverser: [value: Reverser]; horn: [held: boolean]; sand: []; camera: [range: number];
  view: [mode: CameraMode]; speed: [value: number];
}>();
// The session is a plain class; updateKey is bumped every physics/render update so this HUD re-renders.
void props.updateKey;
const speedOptions = APP_CONFIG.simulation.speedOptions;
const openMenu = ref<'view' | 'speed' | 'pause' | null>(null);
const controlsOpen = ref(false);
const menubar = ref<HTMLElement>();

function speedKmh(): string {
  return Math.abs(props.session.train.velocity * 3.6).toFixed(1);
}
function distanceKm(): string {
  return ((props.session.position?.travelled ?? 0) / 1000).toFixed(2);
}
function elapsedText(): string {
  const total = Math.floor(props.session.elapsed);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
function lineName(): string {
  if (!props.session.position) return '未定位';
  const name = props.session.railway.network.segments.get(props.session.position.segmentId)?.properties.name;
  return !name || name === '未命名铁路' ? '未识别轨道' : name;
}
function provinceName(): string {
  return props.session.position?.province ?? '';
}
function practiceText(): string {
  if (props.session.practiceComplete) return '✓ 已完成 1 km 停稳';
  return `${((props.session.position?.travelled ?? 0) / 1000).toFixed(2)} / 1.00 km`;
}
function setThrottle(event: Event): void {
  props.session.setThrottle(Number((event.target as HTMLInputElement).value));
}
function direction(value: Reverser): void {
  emit('reverser', value);
}

function closePopovers(): void {
  openMenu.value = null;
}
function toggleMenu(menu: 'view' | 'speed' | 'pause'): void {
  controlsOpen.value = false;
  openMenu.value = openMenu.value === menu ? null : menu;
}
function hoverMenu(menu: 'view' | 'speed' | 'pause'): void {
  if (openMenu.value) openMenu.value = menu;
}
function direct(action: 'settings' | 'help'): void {
  closePopovers();
  controlsOpen.value = false;
  if (action === 'settings') emit('settings');
  else emit('help');
}
function chooseView(mode: CameraMode): void {
  closePopovers();
  if (mode !== props.cameraMode) emit('view', mode);
}
function togglePause(): void {
  closePopovers();
  emit('pause');
}
function saveProgress(): void {
  closePopovers();
  emit('save');
}
function manageSaves(): void {
  closePopovers();
  emit('saves');
}
function backToMenu(): void {
  closePopovers();
  emit('menu');
}
function setSpeed(value: number): void {
  openMenu.value = null;
  emit('speed', value);
}
function openControls(): void {
  closePopovers();
  controlsOpen.value = !controlsOpen.value;
}

function handlePointerDown(event: PointerEvent): void {
  const target = event.target as Node | null;
  if (openMenu.value && menubar.value && target && !menubar.value.contains(target)) openMenu.value = null;
}
function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (!openMenu.value && !controlsOpen.value) return;
  event.preventDefault();
  event.stopPropagation();
  openMenu.value = null;
  controlsOpen.value = false;
}

onMounted(() => {
  window.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('keydown', handleKeyDown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handlePointerDown);
  window.removeEventListener('keydown', handleKeyDown, true);
});
</script>

<template>
  <div class="driving-ui" :class="{ 'cab-view': cameraMode === 'cab', 'controls-open': controlsOpen }">
    <header ref="menubar" class="drive-menubar">
      <div class="menubar-brand">
        <span class="brand-mark small">CR</span>
        <div class="menubar-brand-copy">
          <strong class="menubar-title">国铁列车驾驶模拟器</strong>
          <span class="menubar-sub">{{ provinceName() }} · {{ lineName() }}</span>
        </div>
      </div>
      <nav class="menubar-nav" aria-label="驾驶菜单">
        <button class="menubar-action" @click="direct('settings')">设置</button>
        <div class="menubar-menu" @mouseenter="hoverMenu('view')">
          <button class="menubar-item" :class="{ open: openMenu === 'view' }" aria-haspopup="menu" :aria-expanded="openMenu === 'view'" @click="toggleMenu('view')">
            视角<span class="caret" aria-hidden="true">▾</span>
          </button>
          <div v-if="openMenu === 'view'" class="menu-dropdown" role="menu" aria-label="视角">
            <button role="menuitemradio" :aria-checked="cameraMode === 'cab'" :class="{ active: cameraMode === 'cab' }" @click="chooseView('cab')">
              <span>第一人称</span><small>驾驶室</small><span class="menu-check">{{ cameraMode === 'cab' ? '✓' : '' }}</span>
            </button>
            <button role="menuitemradio" :aria-checked="cameraMode === 'free'" :class="{ active: cameraMode === 'free' }" @click="chooseView('free')">
              <span>第三人称自由</span><small>外部视角</small><span class="menu-check">{{ cameraMode === 'free' ? '✓' : '' }}</span>
            </button>
            <button role="menuitemradio" :aria-checked="cameraMode === 'fixed'" :class="{ active: cameraMode === 'fixed' }" @click="chooseView('fixed')">
              <span>第三人称后方</span><small>后上方</small><span class="menu-check">{{ cameraMode === 'fixed' ? '✓' : '' }}</span>
            </button>
            <button role="menuitemradio" :aria-checked="cameraMode === 'fixed-front'" :class="{ active: cameraMode === 'fixed-front' }" @click="chooseView('fixed-front')">
              <span>第三人称前方</span><small>前方对向</small><span class="menu-check">{{ cameraMode === 'fixed-front' ? '✓' : '' }}</span>
            </button>
          </div>
        </div>
        <div class="menubar-menu" @mouseenter="hoverMenu('speed')">
          <button class="menubar-item" :class="{ open: openMenu === 'speed' }" aria-haspopup="menu" :aria-expanded="openMenu === 'speed'" @click="toggleMenu('speed')">
            模拟速度<span class="menubar-speed">{{ session.simulationSpeed }}×</span><span class="caret" aria-hidden="true">▾</span>
          </button>
          <div v-if="openMenu === 'speed'" class="menu-dropdown speed-dropdown" role="menu" aria-label="模拟速度">
            <button v-for="speed in speedOptions" :key="speed" role="menuitemradio" :aria-checked="session.simulationSpeed === speed" :class="{ active: session.simulationSpeed === speed }" @click="setSpeed(speed)">
              <span>{{ speed }}×</span><small>{{ speed === 1 ? '实时' : '快进' }}</small><span class="menu-check">{{ session.simulationSpeed === speed ? '✓' : '' }}</span>
            </button>
          </div>
        </div>
        <button class="menubar-action" @click="direct('help')">操作说明</button>
        <div class="menubar-menu" @mouseenter="hoverMenu('pause')">
          <button class="menubar-item" :class="{ open: openMenu === 'pause' }" aria-haspopup="menu" :aria-expanded="openMenu === 'pause'" @click="toggleMenu('pause')">
            暂停与保存<span class="caret" aria-hidden="true">▾</span>
          </button>
          <div v-if="openMenu === 'pause'" class="menu-dropdown pause-dropdown" role="menu" aria-label="暂停与保存">
            <button role="menuitem" @click="togglePause">
              <span>{{ paused ? '继续游戏' : '暂停游戏' }}</span><kbd>P / Esc</kbd>
            </button>
            <button role="menuitem" @click="saveProgress">
              <span>保存进度</span><small>写入本地存档</small>
            </button>
            <button role="menuitem" @click="manageSaves">
              <span>存档管理</span><small>读取 · 导出</small>
            </button>
            <div class="menu-separator" role="separator" />
            <button class="menu-danger" role="menuitem" @click="backToMenu">
              <span>返回主菜单</span><small>自动保存后退出</small>
            </button>
          </div>
        </div>
      </nav>
      <div class="menubar-status">
        <span class="run-state" :class="{ paused: session.paused }"><i aria-hidden="true" />{{ session.paused ? '已暂停' : '运行中' }}</span>
        <span class="practice-chip" :class="{ done: session.practiceComplete }"><small>练习</small><b>{{ practiceText() }}</b></span>
        <button class="sidebar-toggle" :aria-expanded="controlsOpen" aria-label="打开驾驶控制" @click="openControls">控制</button>
      </div>
    </header>

    <main class="drive-display" aria-label="驾驶显示区域">

      <div v-if="session.loadingBorder || session.routeEnd" class="route-status" role="status">
        {{ session.loadingBorder ? '正在检查相邻省份线路，已暂停推进…' : '前方线路中断或连接未确认 · 可换向后退或返回选站' }}
        <button v-if="session.routeEnd && !session.loadingBorder" @click="$emit('retry')">重新检查前方线路</button>
      </div>
      <div v-else-if="session.connectionWarning" class="route-status" role="status">{{ session.connectionWarning }}</div>

      <div v-if="cameraMode !== 'cab'" class="camera-hint">
        {{ cameraMode === 'fixed' || cameraMode === 'fixed-front' ? '左键/单指拖动转动镜头 · 滚轮/双指捏合调整高度' : '左键拖动旋转 · 滚轮缩放' }}
        <div v-if="cameraMode === 'free'"><button @click="$emit('camera', cameraRange - 35)">−</button><button @click="$emit('camera', cameraRange + 35)">＋</button></div>
      </div>
    </main>

    <aside class="drive-sidebar" aria-label="驾驶控制">
      <header class="sidebar-mobile-head">
        <strong>驾驶控制</strong>
        <button aria-label="关闭驾驶控制" @click="controlsOpen = false">×</button>
      </header>

      <div class="sidebar-pair">
        <section class="hud-card speed-card" aria-label="速度板块">
          <div class="card-title"><span>速度板块</span><em>SPEED</em></div>
          <div class="speed-value"><strong>{{ speedKmh() }}</strong><span>km/h</span></div>
          <div class="speed-meta">
            <span>加速度 <b>{{ session.train.acceleration.toFixed(2) }} m/s²</b></span>
            <span>限速 <b>未配置</b></span>
          </div>
        </section>

        <section class="hud-card status-card" aria-label="运行状态">
          <div class="card-title"><span>运行状态</span><em class="live">LIVE</em></div>
          <dl class="status-list">
            <div><dt>线路坡度</dt><dd :class="session.train.slope > 0.0005 ? 'warning-text' : ''">{{ (session.train.slope * 1000 * (Math.sign(session.train.velocity) || session.train.reverser || 1)).toFixed(1) }} ‰</dd></div>
            <div><dt>列车管压</dt><dd>{{ session.train.brakePipe.toFixed(0) }} kPa</dd></div>
            <div><dt>轮轨黏着</dt><dd :class="session.train.adhesionLimited ? 'warning-text' : 'ok-text'">{{ session.train.adhesionLimited ? '黏着不足' : '正常' }}</dd></div>
            <div><dt>撒砂状态</dt><dd>{{ session.train.sandRemaining > 0 ? `${session.train.sandRemaining.toFixed(1)} s` : '未启用' }}</dd></div>
            <div v-if="session.steepGradeAssist.force > 0"><dt>牵引辅助</dt><dd class="ok-text">陡坡牵引辅助</dd></div>
          </dl>
          <div v-if="session.junctionDistance < 120" class="junction-notice">前方 {{ Math.max(0, session.junctionDistance).toFixed(0) }} m 分岔</div>
        </section>
      </div>

      <section class="hud-card control-card traction-card" aria-label="牵引">
        <div class="control-head"><span class="control-name">牵引 <small>TRACTION</small></span><strong>{{ session.train.throttle.toFixed(0) }}<small>%</small></strong></div>
        <input aria-label="牵引手柄" type="range" min="0" max="100" step="1" :value="session.train.throttle" @input="setThrottle" />
        <div class="control-hint"><span><kbd>Shift</kbd> 增加</span><span><kbd>Ctrl</kbd> 减小</span></div>
      </section>

      <section class="hud-card control-card brake-card" aria-label="制动">
        <div class="control-head"><span class="control-name">制动 <small>{{ session.parkingBrake ? '驻车中' : 'BRAKE' }}</small></span><strong>{{ session.train.brakeActual.toFixed(0) }}<small>%</small></strong></div>
        <button class="brake-button" :class="{ engaged: session.brakeHeld }" @pointerdown.prevent="session.brakeHeld = true" @pointerup="session.brakeHeld = false" @pointerleave="session.brakeHeld = false" @pointercancel="session.brakeHeld = false">
          <span>{{ session.brakeHeld ? '制动施加中' : '按住制动' }}</span><i :style="{ width: `${session.train.brakeActual}%` }" />
        </button>
        <div class="brake-footer">
          <span class="key-hint"><kbd>Space</kbd> 按住施加 · 松开缓解</span>
          <button class="parking-toggle" :class="{ active: session.parkingBrake }" @click="$emit('parking')">{{ session.parkingBrake ? '松开驻车' : '启用驻车' }}</button>
        </div>
      </section>

      <section class="hud-card control-card reverser-card" aria-label="换向">
        <div class="control-head"><span class="control-name">换向 <small>REVERSER</small></span><span class="reverser-tip">速度 ≤ 0.5 km/h</span></div>
        <div class="segmented" role="group" aria-label="换向器">
          <button :class="{ active: session.train.reverser === 1 }" @click="direction(1)">前进</button>
          <button :class="{ active: session.train.reverser === 0 }" @click="direction(0)">中立</button>
          <button :class="{ active: session.train.reverser === -1 }" @click="direction(-1)">后退</button>
        </div>
      </section>

      <div class="utility-row">
        <button class="utility-button horn-button" @pointerdown.prevent="$emit('horn', true)" @pointerup="$emit('horn', false)" @pointerleave="$emit('horn', false)"><span>鸣笛</span><kbd>H</kbd></button>
        <button class="utility-button" :class="{ sanding: session.train.sandRemaining > 0 }" @click="$emit('sand')"><span>撒砂</span><kbd>X</kbd></button>
      </div>
    </aside>

    <footer class="drive-statusbar" aria-label="行程信息">
      <div class="status-field"><span>距离</span><strong>{{ distanceKm() }} <i>km</i></strong></div>
      <div class="status-field"><span>运行时间</span><strong>{{ elapsedText() }}</strong></div>
      <div class="status-field"><span>省份</span><strong>{{ provinceName() || '—' }}</strong></div>
      <div class="status-field"><span>线路</span><strong>{{ lineName() }}</strong></div>
      <div class="status-field" title="正在远离的最近车站 · 直线距离，每秒更新"><span>上一最近站</span><strong class="station-distance" v-if="session.nearbyStations.previous" :title="session.nearbyStations.previous!.name"><em>{{ session.nearbyStations.previous!.name }}</em><i>{{ (session.nearbyStations.previous!.distance / 1000).toFixed(1) }} km</i></strong><strong v-else>—</strong></div>
      <div class="status-field" title="正在接近的最近车站 · 直线距离，每秒更新"><span>下一最近站</span><strong class="station-distance" v-if="session.nearbyStations.next" :title="session.nearbyStations.next!.name"><em>{{ session.nearbyStations.next!.name }}</em><i>{{ (session.nearbyStations.next!.distance / 1000).toFixed(1) }} km</i></strong><strong v-else>—</strong></div>
    </footer>

    <div v-if="controlsOpen" class="controls-scrim" @click="controlsOpen = false" />
  </div>
</template>
