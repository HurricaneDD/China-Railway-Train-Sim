<script setup lang="ts">
import { ref } from 'vue';
import type { GameSave } from '../types';

defineProps<{ saves: GameSave[]; busy: boolean; inGame: boolean }>();
const emit = defineEmits<{ close: []; load: [save: GameSave]; delete: [save: GameSave]; save: [name: string]; export: [save: GameSave]; import: [file: File] }>();
const name = ref(`驾驶存档 ${new Date().toLocaleDateString('zh-CN')}`);

function importFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  if (input.files?.[0]) emit('import', input.files[0]);
  input.value = '';
}
function time(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <section class="panel save-panel">
    <header class="panel-header"><div><p class="eyebrow">LOCAL ARCHIVE</p><h2>存档管理</h2></div><button class="icon-button" @click="$emit('close')">×</button></header>
    <div class="save-actions">
      <form v-if="inGame" @submit.prevent="$emit('save', name)"><input v-model="name" required maxlength="40" /><button class="button button-primary" :disabled="busy">保存当前进度</button></form>
      <label class="button button-ghost import-button">导入 JSON 存档<input type="file" accept="application/json,.json" @change="importFile" /></label>
    </div>
    <div class="save-list">
      <article v-for="save in saves" :key="save.id" class="save-card">
        <div class="save-card-main"><span class="save-icon">▣</span><div><strong>{{ save.name }}</strong><small>{{ time(save.savedAt) }} · {{ save.position.province }}</small><small>{{ Math.abs(save.train.velocity * 3.6).toFixed(1) }} km/h · 版本 {{ save.version }}</small></div></div>
        <div class="save-card-actions"><button @click="$emit('load', save)">读取</button><button @click="$emit('export', save)">导出</button><button class="danger-text" @click="$emit('delete', save)">删除</button></div>
      </article>
      <p v-if="!saves.length" class="empty-state">还没有本地存档。开始驾驶后可手动或自动保存。</p>
    </div>
    <footer class="storage-warning">本地数据可能因浏览器清理或设备更换而丢失，请定期导出备份。</footer>
  </section>
</template>
