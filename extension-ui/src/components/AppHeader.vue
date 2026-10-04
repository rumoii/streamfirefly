<script setup lang="ts">
import type { UiContext } from "../types";
import logoUrl from "../../../extension/icon48.png?inline";
import SfIcon from "../ui/SfIcon.vue";

defineProps<{ context: UiContext | null; loading: boolean; compact?: boolean }>();
defineEmits<{ refresh: []; toggleSniffing: [] }>();
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <div class="brand-block">
        <img class="brand-logo" :src="logoUrl" alt="流萤">
        <div><h1>流萤</h1><p>网页媒体发现与下载</p></div>
      </div>
      <div v-if="context" class="source-chip" :class="{ offline: !context.supported }">
        <img v-if="context.favIconUrl" :src="context.favIconUrl" alt="">
        <span v-else class="source-fallback"><SfIcon name="app-window" :size="14" /></span>
        <div><strong>{{ context.pageTitle }}</strong><small>{{ context.pageUrl }}</small></div>
        <span class="source-state"><i></i>{{ context.supported ? context.paused ? '已暂停' : context.sniffingActive ? '正在嗅探' : '等待打开流萤' : '不支持嗅探' }}</span>
      </div>
      <div class="header-actions">
        <button v-if="context?.supported" class="button ghost" type="button" :aria-pressed="context.paused" @click="$emit('toggleSniffing')"><SfIcon :name="context.paused ? 'player-play' : 'player-pause'" /><span>{{ context.paused ? '继续嗅探' : '暂停嗅探' }}</span></button>
        <button class="icon-button" type="button" aria-label="刷新" title="刷新" :disabled="loading" @click="$emit('refresh')"><SfIcon name="refresh" /></button>
      </div>
    </div>
  </header>
</template>
