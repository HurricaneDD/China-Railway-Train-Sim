<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue';
import { neighboringProvinces } from '../../src/data/province-neighbors';
import { RailwayRepository, type JsonFetcher } from '../../src/data/railway';
import type { ProvinceInfo, RailSegment } from '../../src/types';
import { analyzeProvince, type BreakGroup, type BreakKind, type ProvinceAnalysis } from './analysis';
import type { BasemapId } from './basemap';
import RailwayMap from './RailwayMap.vue';

type Category = 'priority' | 'all' | 'filtered' | 'nearby' | 'isolated';
interface MapHandle { fit(): void; focus(lon: number, lat: number, zoom?: number): void; }

const provinces = ref<ProvinceInfo[]>([]);
const selectedProvince = ref('江苏省');
const loadNeighbors = ref(false);
const loading = ref(false);
const loadingMessage = ref('');
const error = ref('');
const notice = ref('');
const analysis = shallowRef<ProvinceAnalysis | null>(null);
const segments = shallowRef<RailSegment[]>([]);
const contextSegments = shallowRef<RailSegment[]>([]);
const selectedId = ref<string | null>(null);
const showFiltered = ref(false);
const showBridgeTunnel = ref(true);
const showIsolated = ref(true);
const basemap = ref<BasemapId>('street');
const category = ref<Category>('priority');
const query = ref('');
const limit = ref(160);
const sidebarOpen = ref(true);
const mapRef = ref<MapHandle | null>(null);
let repository: RailwayRepository | undefined;
let generation = 0;

const fetchInspectorJson: JsonFetcher = async <T>(path: string): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(new URL(`../../data/${path}`, document.baseURI).toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`数据加载失败（${response.status}）：${path}`);
    return await response.json() as T;
  } catch (failure) {
    if (controller.signal.aborted) throw new Error(`数据加载超时：${path}`);
    throw failure;
  } finally {
    clearTimeout(timer);
  }
};

const provinceInfo = computed(() => provinces.value.find(item => item.province === selectedProvince.value));
const stats = computed(() => analysis.value?.stats);
const groups = computed(() => analysis.value?.groups ?? []);
const filteredLinks = computed(() => analysis.value?.filteredLinks ?? []);
const selectedGroup = computed(() => groups.value.find(group => group.id === selectedId.value));
const priorityCount = computed(() => (stats.value?.filteredGroups ?? 0) + (stats.value?.nearbyGroups ?? 0));

const matchingGroups = computed(() => {
  const text = query.value.trim().toLowerCase();
  const byCategory = groups.value.filter(group => {
    if (category.value === 'filtered') return group.kind === 'filtered';
    if (category.value === 'nearby') return group.kind === 'nearby';
    if (category.value === 'isolated') return group.kind === 'isolated';
    if (category.value === 'priority') return group.kind !== 'isolated';
    return true;
  });
  if (!text) return byCategory;
  return byCategory.filter(group => {
    const haystack = [
      group.title, group.id, group.lon.toFixed(6), group.lat.toFixed(6),
      ...group.approaches.flatMap(item => [item.segmentId, item.name, item.osmId]),
      ...group.candidates.flatMap(item => [item.fromSegmentId, item.toSegmentId, item.toName, item.toOsmId, item.reason]),
      ...(group.nearest ? [group.nearest.segmentId, group.nearest.name, group.nearest.osmId, group.nearest.province] : []),
    ].join(' ').toLowerCase();
    return haystack.includes(text);
  });
});
const visibleGroups = computed(() => matchingGroups.value.slice(0, limit.value));

const categoryLabel: Record<BreakKind, string> = {
  filtered: '存在被过滤连接',
  nearby: '邻近线路未接入',
  isolated: '孤立端点',
};

async function ensureRepository(): Promise<void> {
  if (repository) return;
  repository = new RailwayRepository(fetchInspectorJson);
  await repository.loadIndex();
  provinces.value = repository.provinces.map(item => ({ ...item }));
  if (!provinces.value.some(item => item.province === selectedProvince.value)) {
    selectedProvince.value = provinces.value[0]?.province ?? '';
  }
}

async function load(): Promise<void> {
  if (loading.value) return;
  const current = ++generation;
  loading.value = true;
  error.value = '';
  notice.value = '';
  selectedId.value = null;
  analysis.value = null;
  segments.value = [];
  contextSegments.value = [];
  try {
    await ensureRepository();
    const province = provinces.value.find(item => item.province === selectedProvince.value);
    if (!province || !repository) throw new Error('没有可用的省份线路索引');
    loadingMessage.value = `正在加载 ${province.province} 的国铁线路…`;
    await repository.load(province.province);
    if (current !== generation) return;
    if (loadNeighbors.value) {
      const neighbors = neighboringProvinces(province.province)
        .map(name => repository!.byProvince(name))
        .filter((item): item is ProvinceInfo => !!item);
      for (let index = 0; index < neighbors.length; index++) {
        if (current !== generation) return;
        loadingMessage.value = `正在加载邻省 ${index + 1}/${neighbors.length} · ${neighbors[index].province}…`;
        await repository.load(neighbors[index].province);
      }
    }
    if (current !== generation) return;
    loadingMessage.value = '正在计算有向连接与断点…';
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    const result = analyzeProvince(repository.network, province.province);
    if (current !== generation) return;
    analysis.value = result;
    const allSegments = [...repository.network.segments.values()];
    segments.value = allSegments.filter(segment => segment.properties.province === province.province);
    contextSegments.value = allSegments.filter(segment => segment.properties.province !== province.province);
    limit.value = 160;
    const loaded = repoLoadedProvinces();
    notice.value = loadNeighbors.value
      ? `已加载 ${loaded} 个省级数据集，省界断点判定包含邻省。`
      : loaded > 1
        ? `已载入 ${loaded} 省（含先前加载的邻省），本次未新增；这些数据仍参与边界判定。`
        : '仅加载本省数据；省界断点可能因邻省未加载而误报，可勾选“加载邻省”复核。';
    loadingMessage.value = '';
  } catch (failure) {
    if (current === generation) {
      error.value = failure instanceof Error ? failure.message : '线路检查数据加载失败';
      loadingMessage.value = '';
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}

function repoLoadedProvinces(): number {
  return repository?.network.loadedProvinces.size ?? 0;
}

function onProvinceChange(): void {
  void load();
}

function setCategory(value: Category): void {
  category.value = value;
  limit.value = 160;
}

function selectGroup(group: BreakGroup): void {
  selectedId.value = selectedId.value === group.id ? null : group.id;
  if (selectedId.value) {
    mapRef.value?.focus(group.lon, group.lat, 25);
    if (window.innerWidth <= 860) sidebarOpen.value = false;
  }
}

function onMapSelect(id: string | null): void {
  selectedId.value = id;
}

function relativeTime(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)} km` : `${value.toFixed(0)} m`;
}

function formatAngle(value: number): string {
  return `${value >= 0 ? '右' : '左'} ${Math.abs(value).toFixed(1)}°`;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = '已复制到剪贴板';
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
    notice.value = '已复制到剪贴板';
  }
}

function copyCoordinates(): void {
  if (!selectedGroup.value) return;
  void copyText(`${selectedGroup.value.lon.toFixed(7)}, ${selectedGroup.value.lat.toFixed(7)}`);
}

function copyDiagnostics(): void {
  if (!selectedGroup.value) return;
  void copyText(JSON.stringify(selectedGroup.value, null, 2));
}

function exportReport(): void {
  if (!analysis.value || !provinceInfo.value) return;
  const payload = {
    generatedAt: new Date().toISOString(),
    tool: 'dev/railway-check',
    caveat: '派生几何诊断，不是真实铁路调度、信号或工程测量结论；断点为当前驾驶拓扑无可行驶出边的位置。',
    province: provinceInfo.value,
    stats: analysis.value.stats,
    breaks: analysis.value.groups,
    filteredLinks: analysis.value.filteredLinks,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `railway-check-${provinceInfo.value.adcode}.json`;
  link.click();
  URL.revokeObjectURL(url);
  notice.value = '断点报告已导出';
}

onMounted(async () => {
  try {
    await ensureRepository();
    await load();
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '省份索引加载失败';
  }
});
</script>

<template>
  <div class="check-shell" :class="{ 'sidebar-closed': !sidebarOpen }">
    <aside class="check-sidebar">
      <header class="check-brand">
        <div>
          <p class="eyebrow">DEV / RAILWAY CHECK</p>
          <h1>线路人工检查</h1>
          <p class="check-subtitle">分省加载当前运行线路，按派生拓扑标出断点。</p>
        </div>
        <a class="back-link" href="../../">返回模拟器 ↗</a>
      </header>

      <section class="load-block">
        <label class="field">
          <span>省级线路数据集</span>
          <select v-model="selectedProvince" :disabled="loading || !provinces.length" @change="onProvinceChange">
            <option v-for="province in provinces" :key="province.adcode" :value="province.province">{{ province.province }} · {{ province.adcode }}</option>
          </select>
        </label>
        <label class="neighbor-toggle">
          <input v-model="loadNeighbors" type="checkbox" :disabled="loading" @change="load" />
          <span>加载相邻省份辅助检查省界（本次会话保留）</span>
        </label>
        <button class="check-button primary" :disabled="loading" @click="load">{{ loading ? loadingMessage || '正在加载…' : '重新加载并计算断点' }}</button>
        <div class="load-meta">
          <span v-if="provinceInfo">{{ provinceInfo.short_name }} · {{ provinceInfo.feature_count.toLocaleString() }} 原始要素</span>
          <span v-if="stats">已载入 {{ stats.loadedProvinces }} 省 / {{ stats.loadedSegments.toLocaleString() }} 区段</span>
        </div>
      </section>

      <section v-if="stats" class="stats-grid" aria-label="诊断统计">
        <div><small>本省区段</small><strong>{{ stats.provinceSegments.toLocaleString() }}</strong></div>
        <div class="danger"><small>断点</small><strong>{{ stats.groups.toLocaleString() }}</strong></div>
        <div><small>被过滤连接</small><strong>{{ stats.filteredLinks.toLocaleString() }}</strong></div>
        <div><small>桥 / 隧区段</small><strong>{{ stats.bridgeSegments.toLocaleString() }} / {{ stats.tunnelSegments.toLocaleString() }}</strong></div>
        <div><small>弱连通分量</small><strong>{{ stats.weakComponents.toLocaleString() }}</strong></div>
        <div><small>最大分量</small><strong>{{ stats.largestComponent.toLocaleString() }}</strong></div>
      </section>

      <section class="filter-block">
        <div class="search-line">
          <input v-model="query" type="search" placeholder="搜索线路名 / 区段 ID / OSM ID" @input="limit = 160" />
          <button title="适合省域" @click="mapRef?.fit()">⤢</button>
        </div>
        <div class="basemap-row">
          <div class="basemap-caption"><span>地图底图</span><small>WGS84 / EPSG:3857 · 不做 GCJ-02 偏移</small></div>
          <div class="basemap-tabs" role="group" aria-label="地图底图">
            <button :class="{ active: basemap === 'street' }" @click="basemap = 'street'">街道</button>
            <button :class="{ active: basemap === 'satellite' }" @click="basemap = 'satellite'">卫星</button>
            <button :class="{ active: basemap === 'none' }" @click="basemap = 'none'">无</button>
          </div>
        </div>
        <div class="category-tabs" role="group" aria-label="断点筛选">
          <button :class="{ active: category === 'priority' }" @click="setCategory('priority')">重点 {{ priorityCount }}</button>
          <button :class="{ active: category === 'all' }" @click="setCategory('all')">全部 {{ stats?.groups ?? 0 }}</button>
          <button :class="{ active: category === 'filtered' }" @click="setCategory('filtered')">被过滤 {{ stats?.filteredGroups ?? 0 }}</button>
          <button :class="{ active: category === 'nearby' }" @click="setCategory('nearby')">邻近 {{ stats?.nearbyGroups ?? 0 }}</button>
          <button :class="{ active: category === 'isolated' }" @click="setCategory('isolated')">孤立 {{ stats?.isolatedGroups ?? 0 }}</button>
        </div>
        <div class="toggles">
          <label><input v-model="showBridgeTunnel" type="checkbox" />桥隧着色</label>
          <label><input v-model="showIsolated" type="checkbox" />地图显示孤立</label>
          <label><input v-model="showFiltered" type="checkbox" />显示被过滤连接 ({{ filteredLinks.length }})</label>
        </div>
        <div class="list-meta"><span>{{ query ? '搜索结果' : '断点列表' }} · {{ matchingGroups.length.toLocaleString() }}</span><button :disabled="!stats" @click="exportReport">导出本省 JSON</button></div>
      </section>

      <section class="break-list" aria-label="断点列表">
        <button v-for="group in visibleGroups" :key="group.id" class="break-row" :class="[group.kind, { selected: group.id === selectedId }]" @click="selectGroup(group)">
          <span class="break-dot" />
          <span class="break-main">
            <strong>{{ group.title }}</strong>
            <small>{{ categoryLabel[group.kind] }} · {{ group.approaches.length }} 来路 · {{ group.candidates.length }} 候选<span v-if="group.nearest"> · 邻近 {{ relativeTime(group.nearest.distance) }}</span></small>
            <small class="break-id">{{ group.id }}<span v-if="group.bridgeTunnel"> · 桥隧相关</span></small>
          </span>
          <span class="break-coord">{{ group.lon.toFixed(4) }}<br />{{ group.lat.toFixed(4) }}</span>
        </button>
        <p v-if="!visibleGroups.length && !loading" class="empty-state">当前筛选条件下没有断点。</p>
        <button v-if="visibleGroups.length < matchingGroups.length" class="more-button" @click="limit += 160">显示更多（已显示 {{ visibleGroups.length }} / {{ matchingGroups.length }}）</button>
      </section>

      <footer class="check-footer">
        <span class="status-dot" :class="{ online: !loading && !!analysis }" />
        <span v-if="notice">{{ notice }}</span>
        <span v-else>只读工具 · 不修改正式数据</span>
      </footer>
    </aside>

    <main class="check-main">
      <RailwayMap
        ref="mapRef"
        :segments="segments"
        :context-segments="contextSegments"
        :breaks="groups"
        :filtered-links="filteredLinks"
        :selected-id="selectedId"
        :show-filtered="showFiltered"
        :show-bridge-tunnel="showBridgeTunnel"
        :show-isolated="showIsolated"
        :basemap="basemap"
        @select="onMapSelect"
      />
      <button class="sidebar-toggle" @click="sidebarOpen = !sidebarOpen">{{ sidebarOpen ? '收起列表' : '展开列表' }}</button>

      <section class="legend">
        <h2>图例</h2>
        <div><i class="line ground" />普通线路</div>
        <div><i class="line bridge" />桥梁区段 bridge=T</div>
        <div><i class="line tunnel" />隧道区段 tunnel=T</div>
        <div><i class="dot filtered" />断点：存在被过滤连接</div>
        <div><i class="dot nearby" />断点：邻近线路未接入</div>
        <div><i class="dot isolated" />孤立端点</div>
        <div><i class="line filtered-link" />被过滤的候选连接</div>
      </section>

      <div class="map-note">桥隧只依据 OSM 标签识别，不是结构检测；断点是当前派生拓扑无可行驶出边的位置。</div>

      <div v-if="loading" class="check-loading"><span class="spinner" /><div><strong>正在准备线路检查</strong><span>{{ loadingMessage || '读取省份数据…' }}</span></div></div>
      <div v-if="error" class="check-error" role="alert">{{ error }}<button @click="error = ''">×</button></div>

      <section v-if="selectedGroup" class="detail-card">
        <header>
          <div><p class="eyebrow">{{ selectedGroup.kind === 'filtered' ? 'FILTERED CONNECTION' : selectedGroup.kind === 'nearby' ? 'NEARBY UNLINKED' : 'ISOLATED END' }}</p><h2>{{ selectedGroup.title }}</h2></div>
          <button class="close-detail" @click="selectedId = null">×</button>
        </header>
        <div class="detail-tags">
          <span :class="selectedGroup.kind">{{ categoryLabel[selectedGroup.kind] }}</span>
          <span v-if="selectedGroup.bridgeTunnel" class="bridge-tag">桥隧相关</span>
          <span>{{ selectedGroup.approaches.length }} 条来路</span>
          <span>{{ selectedGroup.candidates.length }} 个候选</span>
        </div>
        <div class="detail-coordinates">
          <div><small>断点坐标 WGS84</small><strong>{{ selectedGroup.lon.toFixed(7) }}, {{ selectedGroup.lat.toFixed(7) }}</strong><small>{{ selectedGroup.id }}</small></div>
          <div class="detail-actions">
            <button @click="copyCoordinates">复制坐标</button>
            <button @click="copyDiagnostics">复制 JSON</button>
          </div>
        </div>

        <div class="detail-section">
          <h3>来路区段</h3>
          <div v-for="approach in selectedGroup.approaches" :key="`${approach.segmentId}@${approach.offset}@${approach.direction}`" class="detail-item">
            <div class="item-head"><strong>{{ approach.name }}</strong><span class="mono">{{ approach.direction > 0 ? '正向' : '反向' }} · {{ approach.offset.toFixed(1) }} / {{ approach.length.toFixed(1) }} m</span></div>
            <p class="mono">{{ approach.segmentId }} · OSM {{ approach.osmId }}</p>
            <div class="badges"><span>layer {{ approach.layer }}</span><span v-if="approach.bridge">bridge</span><span v-if="approach.tunnel">tunnel</span></div>
          </div>
        </div>

        <div v-if="selectedGroup.candidates.length" class="detail-section">
          <h3>被过滤的候选连接</h3>
          <div v-for="candidate in selectedGroup.candidates" :key="`${candidate.fromSegmentId}->${candidate.toSegmentId}@${candidate.gap}`" class="detail-item candidate">
            <div class="item-head"><strong>{{ candidate.toName }}</strong><span class="mono">{{ formatAngle(candidate.angle) }}</span></div>
            <p class="mono">{{ candidate.fromSegmentId }} → {{ candidate.toSegmentId }}</p>
            <p class="reason">{{ candidate.reason }}</p>
            <div class="badges"><span>间隙 {{ candidate.gap.toFixed(3) }} m</span><span>OSM {{ candidate.toOsmId }}</span><span>layer {{ candidate.toLayer }}</span><span v-if="candidate.toBridge">bridge</span><span v-if="candidate.toTunnel">tunnel</span></div>
          </div>
        </div>

        <div v-if="selectedGroup.nearest" class="detail-section">
          <h3>最近的其它线路</h3>
          <div class="detail-item">
            <div class="item-head"><strong>{{ selectedGroup.nearest.name }}</strong><span class="mono">{{ relativeTime(selectedGroup.nearest.distance) }}</span></div>
            <p class="mono">{{ selectedGroup.nearest.segmentId }} · OSM {{ selectedGroup.nearest.osmId }}</p>
            <p class="reason">{{ selectedGroup.nearest.province }} · 里程 {{ selectedGroup.nearest.offset.toFixed(1) }} m · {{ selectedGroup.nearest.interior ? '接在折线内部（非端点）' : '接近端点' }}<span v-if="selectedGroup.nearest.sameOsmId"> · 同一 OSM 要素的另一区段</span></p>
            <div class="badges"><span>layer {{ selectedGroup.nearest.layer }}</span><span v-if="selectedGroup.nearest.bridge">bridge</span><span v-if="selectedGroup.nearest.tunnel">tunnel</span></div>
          </div>
        </div>

        <footer class="detail-footer">
          <span>断点不是数据错误结论：先核对原始 OSM 是否共享节点，再决定是否修数据。</span>
          <button @click="mapRef?.focus(selectedGroup.lon, selectedGroup.lat, 30)">放大此处</button>
        </footer>
      </section>

      <div v-if="!loading && !analysis && !error" class="check-empty">选择省份并加载线路数据。</div>
    </main>
  </div>
</template>
