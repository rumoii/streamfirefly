<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { IntegrationConfig, DispatchReceipt } from "../../../../shared/integrations";
import { configurationRequest } from "./client";
interface Intent { tabId: number; sourceContextId: string; candidates: { id: string; url: string; title: string; inline: boolean }[] }
const intent = ref<Intent | null>(null);
const config = ref<IntegrationConfig>({ version: 1, profiles: [] });
const profileId = ref("");
const message = ref("");
const running = ref(false);
const results = ref<Record<string, DispatchReceipt>>({});
const requestIds = new Map<string, string>();
const acknowledged = ref(false);
const previews = ref<Record<string, string>>({});
const previewErrors = ref<Record<string, string>>({});
const previewing = ref(false);
const sourceUnavailable = ref(false);
let previewSequence = 0;
const selected = computed(() => config.value.profiles.find(item => item.id === profileId.value));
const dispatchComplete = computed(() => Boolean(intent.value?.candidates.filter(item => !item.inline).length) && intent.value!.candidates.filter(item => !item.inline).every(item => ["accepted", "started", "requested"].includes(results.value[item.id]?.state)));
watch(profileId, async () => {
  const current = ++previewSequence;
  acknowledged.value = false; previews.value = {}; previewErrors.value = {}; previewing.value = true;
  try {
    for (const candidate of intent.value?.candidates || []) {
      if (candidate.inline) continue;
      try {
        const result = await configurationRequest("integration.preview", { profileId: profileId.value, tabId: intent.value!.tabId, sourceContextId: intent.value!.sourceContextId, candidateId: candidate.id });
        if (current !== previewSequence) return;
        previews.value[candidate.id] = JSON.stringify(result, null, 2);
      } catch (error) { if (current === previewSequence) previewErrors.value[candidate.id] = error instanceof Error ? error.message : "预览失败"; }
    }
  } finally { if (current === previewSequence) previewing.value = false; }
});
onMounted(async () => {
  try {
    intent.value = await configurationRequest("integration.intent", { id: new URLSearchParams(location.search).get("dispatch") });
    const response = await configurationRequest<{ config: IntegrationConfig }>("integration.get"); config.value = response.config;
    profileId.value = config.value.profiles.find(item => item.enabled)?.id || "";
  } catch (error) { message.value = error instanceof Error ? error.message : "读取失败"; }
});
async function send(retryId?: string) {
  if (!intent.value || !selected.value || running.value || previewing.value || !acknowledged.value) return;
  if (retryId && results.value[retryId]?.state !== "failed") return;
  if (retryId) { delete results.value[retryId]; requestIds.delete(retryId); }
  running.value = true;
  try {
    for (const candidate of intent.value.candidates) {
      if (results.value[candidate.id] || candidate.inline || !previews.value[candidate.id] || (retryId && candidate.id !== retryId)) continue;
      const requestId = requestIds.get(candidate.id) || crypto.randomUUID(); requestIds.set(candidate.id, requestId);
      try { results.value[candidate.id] = await configurationRequest("integration.invoke", { requestId, profileId: profileId.value, tabId: intent.value.tabId, sourceContextId: intent.value.sourceContextId, candidateId: candidate.id }); }
      catch (error) { results.value[candidate.id] = { requestId, profileId: profileId.value, state: "unknown", createdAt: Date.now(), error: error instanceof Error ? error.message : "结果未知" }; }
    }
  } finally { running.value = false; }
}
async function returnToSource() {
  if (!intent.value) return;
  try { await configurationRequest("ui.source.activate", { tabId: intent.value.tabId, closeCurrent: true }); }
  catch (reason) { sourceUnavailable.value = true; message.value = reason instanceof Error && reason.message === "page_close_unavailable" ? "已返回来源页，但确认页未能自动关闭。" : "来源标签页已关闭。"; }
}
async function closePage() {
  try { await configurationRequest("ui.page.close"); }
  catch (_) { message.value = "无法关闭当前页，请使用标签页关闭按钮。"; }
}
const labels = { sending: "发送中", accepted: "服务已接收", started: "程序已启动", requested: "已请求打开协议", unknown: "结果未知，未自动重试", failed: "失败" };
</script>
<template><main class="settings-page"><section class="panel feature-panel"><h2>确认发送到外部工具</h2><p>请核对目标和资源。关闭此页不撤销已经发送的任务；外部下载结果由对应工具管理。</p><div class="feature-row"><button v-if="!sourceUnavailable" class="button" :disabled="!intent || running" @click="returnToSource">{{ dispatchComplete ? '完成并返回' : '返回资源页' }}</button><button v-else class="button" @click="closePage">关闭此页</button></div><label class="field"><span>目标工具</span><select v-model="profileId" class="control" :disabled="running || Object.keys(results).length > 0"><option value="">请选择已启用工具</option><option v-for="profile in config.profiles.filter(item => item.enabled)" :key="profile.id" :value="profile.id">{{ profile.name }}</option></select></label><template v-if="selected"><pre class="feature-result">{{ selected.endpoint }}
{{ selected.arguments.join('\n') }}</pre><p>允许发送的请求信息：{{ selected.sensitiveFields.join('、') || '无' }}</p></template><article v-for="candidate in intent?.candidates || []" :key="candidate.id" class="feature-rule"><strong>{{ candidate.title }}</strong><code class="feature-result">{{ candidate.url }}</code><pre v-if="previews[candidate.id]" class="feature-result">{{ previews[candidate.id] }}</pre><p v-if="previewErrors[candidate.id]" role="alert">{{ previewErrors[candidate.id] }}</p><p v-if="candidate.inline">内存清单无法直接交接，请使用内置下载。</p><p v-if="results[candidate.id]" role="status">{{ labels[results[candidate.id].state] }} {{ results[candidate.id].error }} {{ results[candidate.id].gid }}</p><button v-if="results[candidate.id]?.state === 'failed'" class="button" :disabled="running || !acknowledged" @click="send(candidate.id)">重试此项</button></article><label><input v-model="acknowledged" type="checkbox" :disabled="running"> 我确认将这些资源及授权字段发送到所选目标</label><button class="button primary" :disabled="!selected || !acknowledged || running || previewing || !Object.keys(previews).length || Object.keys(results).length > 0" @click="send()">{{ running ? '正在交接…' : '确认发送' }}</button><p v-if="message" role="alert">{{ message }}</p></section></main></template>
