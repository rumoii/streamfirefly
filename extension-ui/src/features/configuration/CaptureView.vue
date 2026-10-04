<script setup lang="ts">
import { onMounted, ref } from "vue";
import type { UiContext } from "../../types";
import CapturePanel from "./CapturePanel.vue";
import { configurationRequest } from "./client";
import SfIcon from "../../ui/SfIcon.vue";
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
  <main class="settings-page standalone-page">
    <header class="page-head"><div><h2>缓存捕捉控制</h2><p :title="context?.pageUrl">{{ context?.pageTitle }} · {{ context?.pageUrl }}</p></div><div class="page-head-actions"><button class="button" @click="refresh"><SfIcon name="refresh" /><span>刷新来源页面状态</span></button><button class="button" :disabled="!context" @click="returnToSource"><SfIcon name="arrow-back-up" /><span>返回来源播放</span></button></div></header>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <CapturePanel :context="context" :target-object-url="targetObjectUrl" />
  </main>
</template>
