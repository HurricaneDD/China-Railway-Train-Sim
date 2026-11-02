<script setup lang="ts">
import { computed, ref } from 'vue';
import type { JunctionRequest } from '../types';
const props = defineProps<{ junction: JunctionRequest }>();
const emit = defineEmits<{ choose: [segmentId: string] }>();
const isDev = import.meta.env.DEV;
const selected = ref<string>();
const active = computed(() => props.junction.options.find(option => option.segmentId === selected.value));
const direction = (angle: number) => Math.abs(angle) < 8 ? '直行' : Math.abs(angle) < 25 ? (angle < 0 ? '略偏左' : '略偏右') : (angle < 0 ? '左前方' : '右前方');
// Rotate local east/north coordinates so the actual approach points upwards.
const diagram = computed(() => {
  const origin = props.junction.options[0]?.preview[0];
  if (!origin) return { paths: [], viewBox: '-50 -50 100 100', radius: 1 };
  const heading = props.junction.incomingBearing * Math.PI / 180;
  const paths = props.junction.options.map(option => ({ id: option.segmentId, points: option.preview.map(point => {
    const east = (point.lon - origin.lon) * Math.cos(origin.lat * Math.PI / 180) * 111195;
    const north = (point.lat - origin.lat) * 111195;
    return { x: east * Math.cos(heading) - north * Math.sin(heading), y: -(east * Math.sin(heading) + north * Math.cos(heading)) };
  }) }));
  // Equal scale in both axes: only viewBox and annotation move, never track geometry.
  let minX = 0, maxX = 0, minY = 0, maxY = 50;
  for (const path of paths) for (const point of path.points) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const padding = Math.max(10, (maxY - minY) * 0.05, (maxX - minX) * 0.05);
  const width = Math.max(50, maxX - minX + 2 * padding), height = Math.max(50, maxY - minY + 2 * padding);
  return { paths: paths.map(path => ({ ...path, points: path.points.map(p => `${p.x},${p.y}`).join(' ') })),
    viewBox: `${(minX + maxX - width) / 2} ${(minY + maxY - height) / 2} ${width} ${height}`,
    radius: Math.max(width, height) / 120 };
});
const activeLine = computed(() => diagram.value.paths.find(line => line.id === selected.value));
const copyDiagnostics = async () => {
  try { await navigator.clipboard.writeText(JSON.stringify({ nodeId: props.junction.nodeId, candidates: props.junction.diagnostics }, null, 2)); }
  catch { /* The selectable diagnostics below remain available without clipboard permission. */ }
};
</script>

<template>
  <div class="modal-backdrop junction-backdrop">
    <section class="junction-dialog" role="dialog" aria-modal="true" aria-labelledby="junction-title">
      <p class="eyebrow">JUNCTION AHEAD</p>
      <h2 id="junction-title">前方道岔</h2>
      <p>当前：{{ junction.currentName }} · 列车已暂停推进</p>
      <svg class="junction-map" :viewBox="diagram.viewBox" role="img" aria-label="按相同比例绘制的道岔路径，来路从下方向上">
        <path d="M0 50 L0 0" class="junction-approach" />
        <polyline v-for="line in diagram.paths" :key="line.id" :points="line.points" class="junction-path" />
        <polyline v-if="activeLine" :points="activeLine.points" class="junction-path active" />
        <circle cx="0" cy="0" :r="diagram.radius" fill="#fff" />
      </svg>
      <p class="junction-map-caption">路径按相同比例绘制；细线可能重合，选中后置顶高亮。</p>
      <div class="junction-key" aria-label="路径编号索引">
        <button v-for="(option, index) in junction.options" :key="option.segmentId" :class="{ selected: selected === option.segmentId }" :aria-pressed="selected === option.segmentId" :aria-label="`预览路径 ${index + 1}`" @click="selected = option.segmentId">{{ String(index + 1).padStart(2, '0') }}</button>
      </div>
      <p class="junction-map-caption">编号按列表顺序排列，不表示股道的实际位置。</p>
      <div class="junction-options">
        <button v-for="(option, index) in junction.options" :key="option.segmentId" :class="{ selected: selected === option.segmentId }" :aria-pressed="selected === option.segmentId" @click="selected = option.segmentId">
          <span class="option-index">{{ String(index + 1).padStart(2, '0') }}</span>
          <span class="bearing-arrow" :style="{ transform: `rotate(${option.angle}deg)` }">↑</span>
          <span><strong>{{ direction(option.angle) }} · {{ option.name }}</strong><small>转向 {{ Math.round(option.angle) }}° · 预览 {{ Math.round(option.previewLength) }} 米 · {{ option.stopReason }}</small><small v-if="option.confidence === 'uncertain'">连接存在数据疑点：{{ option.reason }}</small></span>
        </button>
      </div>
      <button class="junction-confirm" :disabled="!active" @click="active && emit('choose', active.segmentId)">确认所选路径</button>
      <small class="fine-print">点击选项预览，再确认；示意图以行驶方向为上方，非真实站场图。</small>
      <details v-if="isDev" class="junction-diagnostics"><summary>开发诊断</summary><button @click="copyDiagnostics">复制 JSON</button><pre>{{ JSON.stringify({ nodeId: junction.nodeId, candidates: junction.diagnostics }, null, 2) }}</pre></details>
    </section>
  </div>
</template>
