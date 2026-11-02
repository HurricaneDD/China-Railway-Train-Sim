<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { CesiumMap } from '../map/CesiumMap';
import type { GameSession } from '../core/session';

const props = defineProps<{ session: GameSession }>();
const emit = defineEmits<{ ready: [map: CesiumMap]; error: [message: string]; status: [message: string] }>();
const container = ref<HTMLDivElement>();
const warning = ref('');
const fatal = ref(false);
const retrying = ref(false);
let map = new CesiumMap();
let disposed = false;

async function initialize(): Promise<void> {
  try {
    map.attachSession(props.session);
    map.onStatus = message => { warning.value = message; emit('status', message); };
    map.onError = message => { warning.value = message; emit('error', message); };
    await map.initialize(container.value!);
    if (disposed) return;
    fatal.value = false;
    emit('ready', map);
  } catch (error) {
    if (disposed) return;
    map.destroy();
    fatal.value = true;
    warning.value = error instanceof Error ? `三维地图初始化失败：${error.message}` : '三维地图初始化失败';
    emit('error', warning.value);
  }
}

async function retry(): Promise<void> {
  if (retrying.value) return;
  retrying.value = true;
  try {
    if (fatal.value) { map = new CesiumMap(); await initialize(); }
    else await map.retryServices();
  } finally {
    retrying.value = false;
  }
}

defineExpose({ retry });
onMounted(initialize);
onBeforeUnmount(() => { disposed = true; map.destroy(); });
</script>

<template>
  <div ref="container" class="map-canvas" aria-label="三维铁路地图" />
  <div v-if="warning" class="map-service-status" role="status">
    <span>{{ warning }}</span>
    <button :disabled="retrying" @click="retry">{{ retrying ? '重试中…' : '重试地图' }}</button>
    <button v-if="!fatal" aria-label="收起地图提示" @click="warning = ''">×</button>
  </div>
</template>

<style scoped>
.map-service-status { position: fixed; left: 50%; bottom: 10px; transform: translateX(-50%); z-index: 12; display: flex; align-items: center; gap: 10px; max-width: min(92vw, 720px); padding: 10px 14px; background: #1b251eef; border: 1px solid #74835e; color: #eff5e7; font-size: 12px; }
.map-service-status button { flex-shrink: 0; padding: 5px 8px; border: 1px solid #81916d; color: #d8ff62; background: transparent; cursor: pointer; }
</style>
