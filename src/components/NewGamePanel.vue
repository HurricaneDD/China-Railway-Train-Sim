<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { StationRepository } from '../data/stations';
import type { ProvinceInfo, Station, StationResult } from '../types';
import { isStation } from '../types';

const props = defineProps<{ stations: StationRepository; provinces: ProvinceInfo[]; selectedProvince: string; busy: boolean }>();
const emit = defineEmits<{ close: []; province: [name: string]; station: [station: Station]; location: []; }>();
const tab = ref<'station' | 'map'>('station');
const query = ref('');
const province = ref(props.selectedProvince);
const city = ref('');
const results = computed(() => props.stations.search(query.value, province.value, city.value));
const cities = computed(() => props.stations.cities(province.value));
watch(() => props.selectedProvince, (value) => { if (value) province.value = value; });
watch(province, () => { city.value = ''; });

function chooseProvince(): void {
  if (province.value) emit('province', province.value);
}
function choose(station: StationResult): void {
  if (isStation(station)) emit('station', station);
}
</script>

<template>
  <section class="panel new-game-panel">
    <header class="panel-header">
      <div><p class="eyebrow">NEW JOURNEY / 新旅程</p><h2>选择出发位置</h2></div>
      <button class="icon-button" aria-label="关闭" @click="$emit('close')">×</button>
    </header>
    <div class="tabs">
      <button :class="{ active: tab === 'station' }" @click="tab = 'station'">车站出发</button>
      <button :class="{ active: tab === 'map' }" @click="tab = 'map'">地图选点</button>
    </div>
    <div v-if="tab === 'station'" class="panel-body station-picker">
      <label class="search-field"><span>⌕</span><input v-model="query" placeholder="站名 / 电报码 / 旧称" autofocus /></label>
      <div class="filter-row">
        <select v-model="province" aria-label="按省份筛选" @change="chooseProvince">
          <option value="">全部省份</option>
          <option v-for="item in stations.provinces" :key="item" :value="item">{{ item }}</option>
        </select>
        <select v-model="city" :disabled="!province" aria-label="按城市筛选">
          <option value="">全部城市</option>
          <option v-for="item in cities" :key="item" :value="item">{{ item }}</option>
        </select>
      </div>
      <div class="result-meta"><span>{{ query || province || city ? '搜索结果' : '车站名录' }}</span><span>{{ results.length }} 条</span></div>
      <div class="station-results">
        <button v-for="station in results" :key="station.telecode" class="station-row" :disabled="busy || station.pending" @click="choose(station)">
          <span class="station-code">{{ station.telecode }}</span>
          <span class="station-name"><strong>{{ station.name }}<small v-if="station.pending">暂无坐标</small></strong><small>{{ station.pending ? '仅支持检索，不能作为出发位置' : `${station.province} · ${station.city}` }}</small></span>
          <span class="row-arrow">{{ station.pending ? '—' : '→' }}</span>
        </button>
        <p v-if="!results.length" class="empty-state">没有找到匹配的车站</p>
      </div>
    </div>
    <div v-else class="panel-body map-picker">
      <p class="form-label">01 / 选择线路所在省份</p>
      <div class="province-grid">
        <button v-for="item in provinces" :key="item.adcode" :class="{ active: selectedProvince === item.province }" :disabled="busy" @click="$emit('province', item.province)">
          <strong>{{ item.short_name }}</strong><small>{{ (item.size_bytes / 1048576).toFixed(1) }} MB</small>
        </button>
      </div>
      <div class="map-instruction" :class="{ ready: selectedProvince }">
        <span class="step-number">02</span>
        <div><strong>{{ selectedProvince ? `已加载${selectedProvince}` : '等待选择省份' }}</strong><p>{{ selectedProvince ? '在右侧地图上点击铁路附近位置，列车将吸附至最近国铁线路。' : '只加载所选省份，不会读取全国合并文件。' }}</p></div>
      </div>
      <button class="button button-primary full-width" :disabled="!selectedProvince || busy" @click="$emit('location')">{{ busy ? '正在吸附线路…' : '在地图上选择位置' }}</button>
      <p class="fine-print">最大吸附距离 5 km。无坐标车站及非国铁线路不会作为出生点。</p>
    </div>
    <footer class="panel-footer"><span class="status-dot online" />{{ busy ? '正在读取与构建线路拓扑' : '数据仅保存在你的浏览器中' }}</footer>
  </section>
</template>
