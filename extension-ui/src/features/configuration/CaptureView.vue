<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { UiContext } from "../../types";
import CapturePanel from "./CapturePanel.vue";
import { configurationRequest } from "./client";
const context = ref<UiContext | null>(null);
const error = ref("");
async function refresh() {
  try { context.value = await configurationRequest("capture.context", { tabId: Number(new URLSearchParams(location.search).get("captureTab")) }); error.value = ""; }
  catch (reason) { context.value = null; error.value = reason instanceof Error ? reason.message : "读取来源失败"; }
}
onMounted(refresh);
</script>
<template>
  <main class="settings-page">
    <h2>缓存捕捉控制</h2><p>{{ context?.pageTitle }} · {{ context?.pageUrl }}</p>
    <button class="button" @click="refresh">刷新来源页面状态</button>
    <CapturePanel :context="context" /><p v-if="error" role="alert">{{ error }}</p>
  </main>
</template>
