<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { StationRepository } from '../data/stations';
import type { ProvinceInfo, Station, StationResult } from '../types';
import { isStation } from '../types';

const props = defineProps<{ stations: StationRepository; provinces: ProvinceInfo[]; selectedProvince: string; busy: boolean }>();
const emit = defineEmits<{ close: []; province: [name: string]; resetProvince: []; station: [station: Station]; location: [] }>();
// 两步流程：必须先点选具体省份，再进入该省地图预览（车站搜索 / 地图选点）。
const step = computed(() => (props.selectedProvince ? 'preview' : 'province'));
const tab = ref<'station' | 'map'>('station');
const query = ref('');
const city = ref('');
const limit = ref(60);
// 省份预览阶段的检索固定限定在所选省份内；无坐标车站不参与。
const allResults = computed<Station[]>(() => props.stations.search(query.value, props.selectedProvince, city.value, 10000).filter(isStation));
const results = computed(() => allResults.value.slice(0, limit.value));
watch([query, city], () => { limit.value = 60; });
watch(() => props.selectedProvince, () => { city.value = ''; limit.value = 60; });
const cities = computed(() => props.stations.cities(props.selectedProvince));
const stationCount = computed(() => {
  const counts = new Map<string, number>();
  for (const station of props.stations.stations) counts.set(station.province, (counts.get(station.province) ?? 0) + 1);
  return counts;
});

function chooseProvince(item: ProvinceInfo): void {
  if (props.busy) return;
  emit('province', item.province);
}
function choose(station: StationResult): void {
  if (isStation(station)) emit('station', station);
}
</script>

<template>
  <section class="panel new-game-panel">
    <header class="panel-header">
      <div><p class="eyebrow">NEW JOURNEY / 新旅程</p><h2>{{ step === 'province' ? '第一步 · 选择省份' : '选择出发位置' }}</h2></div>
      <button class="icon-button" aria-label="关闭" @click="$emit('close')">×</button>
    </header>

    <!-- 第一步：先点选一个具体省份，才会加载线路并进入地图预览。 -->
    <div v-if="step === 'province'" class="panel-body province-step">
      <p class="form-label">01 / 点选省份（{{ provinces.length }} 个省级线路数据）</p>
      <div class="province-grid tall" aria-label="省份列表">
        <button v-for="item in provinces" :key="item.adcode" :disabled="busy" @click="chooseProvince(item)">
          <strong>{{ item.short_name }}</strong>
          <small>{{ stationCount.get(item.province) ?? 0 }} 站 · {{ (item.size_bytes / 1048576).toFixed(1) }} MB</small>
        </button>
      </div>
      <div class="map-instruction">
        <span class="step-number">02</span>
        <div><strong>进入省份地图预览</strong><p>选定后仅加载该省线路，进入该省地图预览：可搜索该省车站，或在地图上点选位置开始驾驶。不读取全国合并文件。</p></div>
      </div>
    </div>

    <!-- 第二步：省份地图预览，提供省内车站搜索与地图选点两种出发方式。 -->
    <template v-else>
      <div class="province-bar">
        <span>当前省份</span>
        <strong>{{ selectedProvince }}</strong>
        <small>{{ stationCount.get(selectedProvince) ?? 0 }} 个有坐标车站</small>
        <button class="text-button" :disabled="busy" @click="$emit('resetProvince')">更换省份 →</button>
      </div>
      <div class="tabs">
        <button :class="{ active: tab === 'station' }" @click="tab = 'station'">车站搜索</button>
        <button :class="{ active: tab === 'map' }" @click="tab = 'map'">地图选点</button>
      </div>
      <div v-if="tab === 'station'" class="panel-body station-picker">
        <label class="search-field"><span>⌕</span><input v-model="query" :placeholder="`搜索${selectedProvince}的车站 / 电报码 / 旧称`" autofocus /></label>
        <div class="filter-row single">
          <select v-model="city" aria-label="按城市筛选">
            <option value="">全部城市</option>
            <option v-for="item in cities" :key="item" :value="item">{{ item }}</option>
          </select>
        </div>
        <div class="result-meta"><span>{{ query || city ? '搜索结果' : `${selectedProvince}车站名录` }}</span><span>{{ allResults.length }} 条</span></div>
        <div class="station-results">
          <button v-for="station in results" :key="station.telecode" class="station-row" :disabled="busy" @click="choose(station)">
            <span class="station-code">{{ station.telecode }}</span>
            <span class="station-name"><strong>{{ station.name }}</strong><small>{{ station.province }} · {{ station.city }}</small></span>
            <span class="row-arrow">→</span>
          </button>
          <button v-if="results.length < allResults.length" class="button button-ghost full-width" @click="limit += 60">显示更多车站（已显示 {{ results.length }}）</button>
          <p v-if="!results.length" class="empty-state">该省份没有匹配的车站，可改用地图选点</p>
        </div>
        <p class="fine-print">检索范围已限定为{{ selectedProvince }}；也可直接点击预览地图上的车站圆点出发。</p>
      </div>
      <div v-else class="panel-body map-picker">
        <div class="map-instruction ready">
          <span class="step-number">01</span>
          <div><strong>{{ selectedProvince }}地图预览</strong><p>黄绿色线条为该省国铁区段，圆点为有坐标车站，可自由缩放平移查看。</p></div>
        </div>
        <div class="map-instruction">
          <span class="step-number">02</span>
          <div><strong>地图选点出发</strong><p>直接点击地图上铁路附近的位置或车站圆点，列车将吸附至最近国铁线路并开始驾驶。</p></div>
        </div>
        <button class="button button-primary full-width" :disabled="busy" @click="$emit('location')">{{ busy ? '正在处理线路数据…' : '收起面板 · 全屏地图选点' }}</button>
        <p class="fine-print">最大吸附距离 5 km，超出会明确失败并保留在预览。无坐标车站及非国铁线路不会作为出生点。</p>
      </div>
    </template>
    <footer class="panel-footer"><span class="status-dot online" />{{ busy ? '正在读取与构建线路拓扑' : '数据仅保存在你的浏览器中' }}</footer>
  </section>
</template>
