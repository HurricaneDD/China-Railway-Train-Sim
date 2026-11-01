<script setup lang="ts">
defineProps<{ hasSave: boolean; ready: boolean }>();
defineEmits<{ continue: []; new: []; saves: []; settings: [] }>();
</script>

<template>
  <main class="start-screen">
    <header class="start-header">
      <div class="brand-mark"><span>CR</span></div>
      <span>CHINA RAILWAY TRAIN SIM</span>
      <span class="version">V 1.0</span>
    </header>
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow"><span /> 真实地理 · 自由驾驶</p>
        <h1>国铁列车<br /><strong>驾驶模拟器</strong></h1>
        <p class="hero-description">驶上真实中国铁路网络。<br />每一次前行，都由你掌控。</p>
        <div class="menu-actions">
          <button class="button button-primary button-large" :disabled="!ready" @click="$emit('new')">
            <span>开始新游戏</span><b>↗</b>
          </button>
          <button class="button button-ghost button-large" :disabled="!hasSave || !ready" @click="$emit('continue')">
            <span>继续游戏</span><small>{{ hasSave ? '恢复最近进度' : '暂无有效存档' }}</small>
          </button>
          <div class="secondary-actions">
            <button class="text-button" @click="$emit('saves')">存档管理 <span>→</span></button>
            <button class="text-button" @click="$emit('settings')">游戏设置 <span>→</span></button>
          </div>
        </div>
      </div>
      <div class="hero-aside" aria-hidden="true">
        <div class="route-number">01<span>/ 中国铁路</span></div>
        <div class="track-art"><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
        <div class="coordinate">35.8617° N<br />104.1954° E</div>
      </div>
    </section>
    <footer class="start-footer">
      <span><i class="status-dot" :class="{ online: ready }" />{{ ready ? '系统就绪' : '正在加载地图与数据' }}</span>
      <span>WGS84 · CESIUM 3D · LOCAL SAVE</span>
    </footer>
  </main>
</template>
