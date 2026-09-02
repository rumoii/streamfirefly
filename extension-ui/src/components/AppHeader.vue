<script setup lang="ts">
import type { PageContext } from "../types";
import { runtimeUrl } from "../api";
import logoUrl from "../../../extension/icon48.png?inline";

defineProps<{ session: PageContext | null; loading: boolean }>();
defineEmits<{ refresh: []; toggleSniffing: []; focusSource: [] }>();
</script>

<template>
  <header class="app-header">
    <div class="app-header-inner">
      <div class="brand-block">
        <img class="brand-logo" :src="runtimeUrl('icon48.png', logoUrl)" alt="流萤">
        <div><h1>流萤</h1><p>网页媒体发现与下载</p></div>
      </div>
      <div v-if="session" class="source-chip" :class="{ offline: session.sourceClosed }">
        <img v-if="session.favIconUrl" :src="session.favIconUrl" alt="">
        <span v-else class="source-fallback">⌁</span>
        <div><strong>{{ session.pageTitle }}</strong><small>{{ session.sourceClosed ? '来源页面已关闭' : session.pageUrl }}</small></div>
        <span class="source-state"><i></i>{{ session.sourceClosed ? '已关闭' : session.supported ? '正在嗅探' : '不支持嗅探' }}</span>
      </div>
      <div class="header-actions">
        <button v-if="session && !session.sourceClosed" class="button subtle" type="button" @click="$emit('focusSource')">返回来源页</button>
        <button v-if="session && !session.sourceClosed && session.supported" class="button subtle" type="button" :aria-pressed="session.paused" @click="$emit('toggleSniffing')">{{ session.paused ? '继续嗅探' : '暂停嗅探' }}</button>
        <button class="icon-button" type="button" aria-label="刷新" :disabled="loading" @click="$emit('refresh')">↻</button>
      </div>
    </div>
  </header>
</template>
