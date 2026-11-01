<script setup lang="ts">
import type { GameSession } from '../core/session';
import type { Reverser } from '../types';

const props = defineProps<{ session: GameSession; updateKey: number; cameraRange: number; cameraMode: 'cab' | 'external' }>();
const emit = defineEmits<{ menu: []; save: []; settings: []; reverser: [value: Reverser]; horn: [held: boolean]; sand: []; camera: [range: number]; view: []; }>();
void props.updateKey;

function lineName(): string {
  if (!props.session.position) return '未定位';
  return props.session.railway.network.segments.get(props.session.position.segmentId)?.properties.name ?? '未命名铁路';
}
function provinceName(): string {
  return props.session.position?.province ?? '';
}
function setThrottle(event: Event): void {
  props.session.setThrottle(Number((event.target as HTMLInputElement).value));
}
function direction(value: Reverser): void {
  emit('reverser', value);
}
</script>

<template>
  <div class="driving-ui" :class="{ 'cab-view': cameraMode === 'cab' }">
    <div v-if="cameraMode === 'cab'" class="cab-shell" aria-hidden="true">
      <div class="cab-roof"><span>中国铁路 · 驾驶室</span></div>
      <div class="cab-pillar left" /><div class="cab-pillar right" />
      <div class="cab-wiper" />
      <div class="cab-dashboard"><div class="cab-vents" /><span>CHINA RAILWAY / DRIVER'S DESK</span></div>
    </div>
    <header class="drive-topbar">
      <div class="drive-brand"><span class="brand-mark small">CR</span><div><strong>国铁列车驾驶模拟器</strong><small>{{ provinceName() }} · {{ lineName() }}</small></div></div>
      <div class="topbar-actions">
        <button class="view-toggle" @click="$emit('view')">{{ cameraMode === 'cab' ? '切换外部视角' : '返回驾驶室' }}</button>
        <button @click="$emit('save')">保存进度</button>
        <button @click="$emit('settings')">设置</button>
        <button class="square-button" aria-label="返回主菜单" @click="$emit('menu')">☰</button>
      </div>
    </header>

    <section class="speed-cluster">
      <p>当前速度 <span>SPEED</span></p>
      <div><strong>{{ Math.abs(session.train.velocity * 3.6).toFixed(1) }}</strong><span>km/h</span></div>
      <div class="speed-sub"><span>加速度 <b>{{ session.train.acceleration.toFixed(2) }} m/s²</b></span><span>限速 <b>未配置</b></span></div>
    </section>

    <aside class="telemetry">
      <div class="telemetry-title">运行状态 <span class="live-tag">LIVE</span></div>
      <dl>
        <div><dt>线路坡度</dt><dd :class="session.train.slope > 0.0005 ? 'warning-text' : ''">{{ (session.train.slope * 1000).toFixed(1) }} ‰</dd></div>
        <div><dt>列车管压力</dt><dd>{{ session.train.brakePipe.toFixed(0) }} kPa</dd></div>
        <div><dt>轮轨黏着</dt><dd :class="session.train.adhesionLimited ? 'warning-text' : 'ok-text'">{{ session.train.adhesionLimited ? '黏着不足' : '正常' }}</dd></div>
        <div><dt>撒砂状态</dt><dd>{{ session.train.sandRemaining > 0 ? `${session.train.sandRemaining.toFixed(1)} s` : '未启用' }}</dd></div>
      </dl>
      <div v-if="session.junctionDistance < 120" class="junction-notice">前方 {{ Math.max(0, session.junctionDistance).toFixed(0) }} m 分岔</div>
    </aside>

    <div v-if="cameraMode === 'external'" class="camera-hint">左键拖动旋转 · 滚轮缩放 <div><button @click="$emit('camera', cameraRange - 35)">−</button><button @click="$emit('camera', cameraRange + 35)">＋</button></div></div>

    <section class="control-deck">
      <div class="handle-control traction-control">
        <div class="control-label"><span>牵引手柄</span><strong>{{ session.train.throttle.toFixed(0) }}<small>%</small></strong></div>
        <input aria-label="牵引手柄" type="range" min="0" max="100" step="1" :value="session.train.throttle" @input="setThrottle" />
        <div class="key-hint"><kbd>Shift</kbd> 增加 <kbd>Ctrl</kbd> 减小</div>
      </div>
      <div class="handle-control brake-control">
        <div class="control-label"><span>制动</span><strong>{{ session.train.brakeActual.toFixed(0) }}<small>%</small></strong></div>
        <button class="brake-button" :class="{ engaged: session.brakeHeld }" @pointerdown.prevent="session.brakeHeld = true" @pointerup="session.brakeHeld = false" @pointerleave="session.brakeHeld = false" @pointercancel="session.brakeHeld = false">
          <span>{{ session.brakeHeld ? '制动施加中' : '按住制动' }}</span><i :style="{ width: `${session.train.brakeActual}%` }" />
        </button>
        <div class="key-hint"><kbd>Space</kbd> 按住施加 · 松开缓解</div>
      </div>
      <div class="reverser-control">
        <span class="control-caption">换向器</span>
        <div class="segmented">
          <button :class="{ active: session.train.reverser === 1 }" @click="direction(1)">前进</button>
          <button :class="{ active: session.train.reverser === 0 }" @click="direction(0)">中立</button>
          <button :class="{ active: session.train.reverser === -1 }" @click="direction(-1)">后退</button>
        </div>
        <small>速度 ≤ 0.5 km/h 时可换向</small>
      </div>
      <div class="utility-controls">
        <button class="horn-button" @pointerdown.prevent="$emit('horn', true)" @pointerup="$emit('horn', false)" @pointerleave="$emit('horn', false)"><span>鸣笛</span><kbd>H</kbd></button>
        <button :class="{ sanding: session.train.sandRemaining > 0 }" @click="$emit('sand')"><span>撒砂</span><kbd>X</kbd></button>
      </div>
    </section>
  </div>
</template>
