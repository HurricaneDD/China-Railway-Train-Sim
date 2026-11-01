<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { CesiumMap } from '../map/CesiumMap';
import type { GameSession } from '../core/session';

const props = defineProps<{ session: GameSession }>();
const emit = defineEmits<{ ready: [map: CesiumMap]; error: [message: string] }>();
const container = ref<HTMLDivElement>();
const map = new CesiumMap();

onMounted(async () => {
  try {
    map.attachSession(props.session);
    await map.initialize(container.value!);
    emit('ready', map);
  } catch (error) {
    emit('error', error instanceof Error ? `三维地图初始化失败：${error.message}` : '三维地图初始化失败');
  }
});
onBeforeUnmount(() => map.destroy());
</script>

<template>
  <div ref="container" class="map-canvas" aria-label="三维铁路地图" />
</template>
