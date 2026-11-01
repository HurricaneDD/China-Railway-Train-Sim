<script setup lang="ts">
import type { JunctionRequest } from '../types';
defineProps<{ junction: JunctionRequest }>();
defineEmits<{ choose: [segmentId: string] }>();
</script>

<template>
  <div class="modal-backdrop junction-backdrop">
    <section class="junction-dialog" role="dialog" aria-modal="true" aria-labelledby="junction-title">
      <div class="junction-icon">⑂</div>
      <p class="eyebrow">JUNCTION AHEAD</p>
      <h2 id="junction-title">前方铁路分岔</h2>
      <p>列车已暂停推进，请选择后续行驶方向。</p>
      <div class="junction-options">
        <button v-for="(option, index) in junction.options" :key="option.segmentId" @click="$emit('choose', option.segmentId)">
          <span class="option-index">0{{ index + 1 }}</span>
          <span class="bearing-arrow" :style="{ transform: `rotate(${option.bearing}deg)` }">↑</span>
          <span><strong>{{ option.name }}</strong><small>{{ option.direction }}方向 · 邻近 {{ option.nextStation }}</small></span>
          <b>→</b>
        </button>
      </div>
      <small class="fine-print">必须主动选择，系统不会默认切换线路</small>
    </section>
  </div>
</template>
