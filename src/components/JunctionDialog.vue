<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { JunctionRequest } from '../types';
import JunctionMap from './JunctionMap.vue';

const props = defineProps<{ junction: JunctionRequest }>();
const emit = defineEmits<{ choose: [segmentId: string] }>();
const isDev = import.meta.env.DEV;
const selected = ref<string>();
const optionsList = ref<HTMLElement>();
const active = computed(() => props.junction.options.find(option => option.segmentId === selected.value));
const activeIndex = computed(() => props.junction.options.findIndex(option => option.segmentId === selected.value));
const selectionCounter = computed(() => activeIndex.value < 0
  ? `-- / ${String(props.junction.options.length).padStart(2, '0')}`
  : `${String(activeIndex.value + 1).padStart(2, '0')} / ${String(props.junction.options.length).padStart(2, '0')}`);
const direction = (angle: number) => Math.abs(angle) < 8 ? '直行' : Math.abs(angle) < 25 ? (angle < 0 ? '略偏左' : '略偏右') : (angle < 0 ? '左前方' : '右前方');

watch(() => props.junction.nodeId, () => { selected.value = undefined; });
watch(selected, async (id) => {
  if (!id) return;
  await nextTick();
  // Scroll only the option list, never the dialog/page; a map click must keep the
  // freshly marked route visible on the left.
  const list = optionsList.value;
  const button = list?.querySelector<HTMLElement>(`[data-option-index="${activeIndex.value}"]`);
  if (!list || !button) return;
  if (button.offsetTop < list.scrollTop) list.scrollTop = button.offsetTop;
  else if (button.offsetTop + button.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = button.offsetTop + button.offsetHeight - list.clientHeight;
  }
});

function selectOption(segmentId: string): void {
  selected.value = segmentId;
}

const copyDiagnostics = async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify({
      nodeId: props.junction.nodeId,
      mapCenter: props.junction.context.center,
      nearbyTracks: props.junction.context.tracks.length,
      candidates: props.junction.diagnostics,
    }, null, 2));
  } catch {
    /* The selectable diagnostics below remain available without clipboard permission. */
  }
};
</script>

<template>
  <div class="modal-backdrop junction-backdrop">
    <section class="junction-dialog" role="dialog" aria-modal="true" aria-labelledby="junction-title">
      <header class="junction-header">
        <div>
          <p class="eyebrow">JUNCTION AHEAD · 前方道岔</p>
          <h2 id="junction-title">选择走行线路</h2>
          <p class="junction-current">当前：{{ junction.currentName }} <span>·</span> 列车已暂停推进</p>
        </div>
        <div class="junction-head-status">
          <span class="junction-status-dot" />
          <span><b>{{ junction.options.length }}</b> 条可行线路</span>
        </div>
      </header>

      <div class="junction-body">
        <section class="junction-map-panel" aria-label="附近配线图面板">
          <div class="junction-section-head">
            <div>
              <h3>附近配线图</h3>
              <p>地理底图叠加真实线路坐标；灰线为周边线路，彩色线为本次可选走线。</p>
            </div>
            <span class="junction-map-hint">点击线路选择</span>
          </div>

          <JunctionMap :junction="junction" :selected="selected" @select="selectOption" />

          <div class="junction-map-legend" aria-label="地图图例">
            <span><i class="legend-line nearby" />周边线路</span>
            <span><i class="legend-line candidate" />可选线路</span>
            <span><i class="legend-line selected" />已选走线</span>
            <span><i class="legend-node" />道岔位置</span>
            <span><i class="legend-arrow">↑</i>行驶方向</span>
          </div>
          <p class="junction-map-caption">地图北向上、横纵同尺度；底图仅作地理参考，不表示真实道岔联锁或信号开放状态。</p>
        </section>

        <aside class="junction-choice-panel" aria-label="走行线路选择">
          <div class="junction-section-head">
            <div>
              <h3>可选走行线路</h3>
              <p>选择后仍可在地图和选项中改选，确认前不会推进列车。</p>
            </div>
            <span class="junction-choice-count">{{ selectionCounter }}</span>
          </div>

          <div ref="optionsList" class="junction-options">
            <button v-for="(option, index) in junction.options" :key="option.segmentId" :class="{ selected: selected === option.segmentId }" :data-option-index="index" :aria-pressed="selected === option.segmentId" @click="selectOption(option.segmentId)">
              <span class="option-index">{{ String(index + 1).padStart(2, '0') }}</span>
              <span class="bearing-arrow" :style="{ transform: `rotate(${option.angle}deg)` }" aria-hidden="true">↑</span>
              <span class="option-copy">
                <span class="option-title"><strong>{{ direction(option.angle) }} · {{ option.name }}</strong><em>{{ option.direction }}</em></span>
                <span class="option-meta">转向 {{ Math.round(option.angle) }}° · 预览 {{ Math.round(option.previewLength) }} 米 · {{ option.stopReason }}</span>
                <span v-if="option.confidence === 'uncertain'" class="option-warning">连接存在数据疑点：{{ option.reason }}</span>
              </span>
              <span class="option-check" aria-hidden="true">{{ selected === option.segmentId ? '✓' : '›' }}</span>
            </button>
          </div>

          <div class="junction-choice-footer">
            <p class="junction-selection-status" aria-live="polite">
              <template v-if="active"><span>已标记</span> <b>{{ String(activeIndex + 1).padStart(2, '0') }}</b> {{ direction(active.angle) }} · {{ active.name }}</template>
              <template v-else>尚未选择，点击地图彩色线路或右侧选项</template>
            </p>
            <button class="junction-confirm" :disabled="!active" @click="active && emit('choose', active.segmentId)">
              <span>确认所选路径</span>
              <b>→</b>
            </button>
            <small class="junction-fine-print">确认后列车按所选线路继续；本提示不替代真实行车凭证与信号确认。</small>
            <details v-if="isDev" class="junction-diagnostics">
              <summary>开发诊断</summary>
              <button @click="copyDiagnostics">复制 JSON</button>
              <pre>{{ JSON.stringify({ nodeId: junction.nodeId, candidates: junction.diagnostics }, null, 2) }}</pre>
            </details>
          </div>
        </aside>
      </div>
    </section>
  </div>
</template>
