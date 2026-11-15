<script setup lang="ts">
import { mediaUrl } from '../utils/assets';

// Single decorative backdrop; the 3D globe stays mounted behind the start screen for loading.
const src = mediaUrl('index/04-trunk-lines.png');
</script>

<template>
  <div class="home-backdrop" aria-hidden="true">
    <figure class="home-backdrop-image">
      <img :src="src" alt="" decoding="async" draggable="false" />
    </figure>
    <div class="home-backdrop-shade" />
  </div>
</template>
