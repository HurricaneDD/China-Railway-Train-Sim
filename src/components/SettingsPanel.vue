<script setup lang="ts">
import type { GameSettings } from '../config';
defineProps<{ settings: GameSettings }>();
defineEmits<{ close: []; change: [settings: GameSettings] }>();
</script>

<template>
  <section class="panel settings-panel">
    <header class="panel-header"><div><p class="eyebrow">PREFERENCES</p><h2>游戏设置</h2></div><button class="icon-button" @click="$emit('close')">×</button></header>
    <div class="settings-body">
      <div class="setting-row"><div><strong>驾驶音效</strong><small>鸣笛与操作反馈</small></div><label class="switch"><input type="checkbox" :checked="settings.sound" @change="$emit('change', { ...settings, sound: ($event.target as HTMLInputElement).checked })" /><span /></label></div>
      <div class="setting-row"><div><strong>自动保存</strong><small>驾驶中每 30 秒保存，切到后台时补充保存</small></div><label class="switch"><input type="checkbox" :checked="settings.autosave" @change="$emit('change', { ...settings, autosave: ($event.target as HTMLInputElement).checked })" /><span /></label></div>
      <label class="range-setting"><span><strong>默认观察距离</strong><b>{{ settings.cameraRange }} m</b></span><input type="range" min="35" max="900" step="5" :value="settings.cameraRange" @input="$emit('change', { ...settings, cameraRange: Number(($event.target as HTMLInputElement).value) })" /></label>
      <label class="range-setting"><span><strong>轨道显示范围</strong><b>{{ (settings.renderRadius / 1000).toFixed(1) }} km</b></span><input type="range" min="2000" max="10000" step="500" :value="settings.renderRadius" @input="$emit('change', { ...settings, renderRadius: Number(($event.target as HTMLInputElement).value) })" /></label>
      <div class="keyboard-guide"><h3>键盘操作</h3><div><span><kbd>Shift</kbd> 增加牵引</span><span><kbd>Ctrl</kbd> 减小牵引</span><span><kbd>Space</kbd> 制动 / 缓解</span><span><kbd>H</kbd> 鸣笛</span><span><kbd>X</kbd> 撒砂</span><span>鼠标拖动 / 滚轮 视角</span></div></div>
      <details class="data-credits"><summary>数据来源与许可</summary><p>车站资料来自 12306 车站地址接口；铁路几何来自 OpenStreetMap 贡献者，遵循 ODbL 1.0。原始数据整理自 CRTrainRoute（MIT License）。车站和线路均使用 WGS84 坐标。</p><p>本应用不包含虚构全国限速。地形坡度来自 Cesium ion，仅用于第一版估算，不等同于真实铁路纵断面。</p></details>
    </div>
  </section>
</template>
