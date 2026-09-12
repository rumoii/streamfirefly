<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { UiContext } from "../../types";
import CapturePanel from "./CapturePanel.vue";
import { configurationRequest } from "./client";
const context = ref<UiContext | null>(null);
const error = ref("");
const query = new URLSearchParams(location.search);
const targetObjectUrl = ref(query.get("captureBlob")?.startsWith("blob:") ? query.get("captureBlob")! : "");
async function refresh() {
  try { context.value = await configurationRequest("capture.context", { tabId: Number(new URLSearchParams(location.search).get("captureTab")) }); error.value = ""; }
  catch (reason) { context.value = null; error.value = reason instanceof Error ? reason.message : "读取来源失败"; }
}
async function returnToSource() {
  if (!context.value) return;
  try { await configurationRequest("ui.source.activate", { tabId: context.value.sourceTabId, closeCurrent: false }); error.value = ""; }
  catch (reason) { error.value = reason instanceof Error && reason.message !== "source_tab_unavailable" ? reason.message : "来源标签页已关闭。"; }
}
onMounted(refresh);
</script>
<template>
  <main class="settings-page">
    <h2>缓存捕捉控制</h2><p>{{ context?.pageTitle }} · {{ context?.pageUrl }}</p>
    <div class="feature-row"><button class="button" @click="refresh">刷新来源页面状态</button><button class="button" :disabled="!context" @click="returnToSource">返回来源播放</button></div>
    <CapturePanel :context="context" :target-object-url="targetObjectUrl" /><p v-if="error" role="alert">{{ error }}</p>
  </main>
</template>
