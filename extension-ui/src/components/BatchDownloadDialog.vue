<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { MediaCandidate } from "../types";
import { createDownload, prepareCandidate } from "../download-client";
import { sendMessage } from "../api";
import { humanError } from "../store";
import { vModalFocus } from "../modal-focus";

const props = defineProps<{ candidates: MediaCandidate[] | null; saveDir: string; downloadThreads: number; sourceContextId: string | null; sourceTabId: number | null; connected: boolean }>();
const emit = defineEmits<{ close: []; inspect: [candidate: MediaCandidate] }>();
type BatchItem = { candidate: MediaCandidate; requestId: string; state: "pending" | "preparing" | "queued" | "failed" | "manual" | "stopped"; message: string };
const items = ref<BatchItem[]>([]);
const busy = ref(false);
const submitted = ref(false);
const confirmStop = ref(false);
const stopped = ref(false);
const directory = ref("");
let alive = true;
let sourceContextAtOpen: string | null = null;
let sourceTabAtOpen: number | null = null;
const summary = computed(() => `已入队 ${items.value.filter(item => item.state === 'queued').length} · 失败 ${items.value.filter(item => item.state === 'failed').length} · 需单独处理 ${items.value.filter(item => item.state === 'manual').length}`);
watch(() => props.candidates, candidates => {
  if (busy.value) return;
  submitted.value = false; stopped.value = false; confirmStop.value = false;
  directory.value = props.saveDir;
  sourceContextAtOpen = props.sourceContextId;
  sourceTabAtOpen = props.sourceTabId;
  items.value = (candidates || []).map(candidate => ({ candidate: { ...candidate, requestHeaders: { ...candidate.requestHeaders } }, requestId: crypto.randomUUID(), state: candidate.url.startsWith("blob:") || candidate.type === "dash" || candidate.live ? "manual" : "pending", message: candidate.url.startsWith("blob:") ? "Blob 请单独缓存捕捉" : candidate.type === "dash" ? "DASH请单独解析" : candidate.live ? "直播请单独启动录制" : "等待确认" }));
}, { immediate: true });

function requestClose() { if (busy.value) confirmStop.value = true; else emit("close"); }
function stop() { stopped.value = true; confirmStop.value = false; }
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value) { event.preventDefault(); event.returnValue = ""; } }
function beforeWorkspaceClose(event: Event) { if (busy.value) { event.preventDefault(); confirmStop.value = true; } }
window.addEventListener("streamfirefly-workspace-before-close", beforeWorkspaceClose);
watch(busy, value => value ? window.addEventListener("beforeunload", beforeUnload) : window.removeEventListener("beforeunload", beforeUnload));
onBeforeUnmount(() => { alive = false; stopped.value = true; window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("streamfirefly-workspace-before-close", beforeWorkspaceClose); });

async function submit() {
  if (busy.value || submitted.value || !props.connected) return;
  busy.value = true; submitted.value = true;
  const sourceContextId = sourceContextAtOpen;
  const sourceTabId = sourceTabAtOpen;
  const downloadThreads = props.downloadThreads;
  const saveDir = directory.value.trim();
  try {
    for (const item of items.value) {
      if (item.state !== "pending") continue;
      if (stopped.value || !alive) { item.state = "stopped"; item.message = "未提交"; continue; }
      item.state = "preparing"; item.message = "正在准备";
      try {
        const payload = await prepareCandidate(item.candidate, sourceTabId);
        if (stopped.value || !alive) { item.state = "stopped"; item.message = "未提交"; continue; }
        const prepared = await sendMessage({ type: "task.prepare", payload });
        if (!prepared?.ok) throw new Error(prepared?.error || "task_prepare_failed");
        if (stopped.value || !alive) { item.state = "stopped"; item.message = "未提交"; continue; }
        const task = await createDownload({ ...payload, sourceContextId, saveDir: saveDir || null, downloadThreads, fileName: prepared.payload.fileName }, item.requestId);
        item.state = "queued"; item.message = `已入队：${task.title}`;
      } catch (reason: any) {
        const message = humanError(reason?.message);
        item.state = /直播|密钥|DRM|SAMPLE-AES|LL-HLS/.test(message) ? "manual" : "failed";
        item.message = message;
      }
    }
  } finally { busy.value = false; }
}

function retryFailed() {
  if (busy.value || !props.connected) return;
  for (const item of items.value) if (item.state === "failed") { item.state = "pending"; item.message = "等待重试"; }
  submitted.value = false; stopped.value = false;
  void submit();
}
</script>

<template>
  <div v-if="candidates" class="dialog-backdrop" @click.self="requestClose">
    <section v-modal-focus="requestClose" class="dialog batch-dialog" role="dialog" aria-modal="true" aria-labelledby="batch-title">
      <div class="dialog-heading"><div><h2 id="batch-title">批量下载 {{ items.length }} 项资源</h2><p>HLS默认最高画质、默认音轨、全片，不附带字幕。最多同时执行2个任务。</p></div><button class="icon-button" aria-label="关闭批量下载" @click="requestClose">×</button></div>
      <label class="field"><span>保存目录</span><input v-model="directory" class="control" :disabled="submitted" placeholder="留空使用系统默认目录"></label>
      <div class="batch-results"><article v-for="item in items" :key="item.requestId"><strong>{{ item.candidate.title || item.candidate.pageTitle || item.candidate.url }}</strong><span :class="{ 'metric-danger': item.state === 'failed' }">{{ item.message }}</span><button v-if="item.state === 'manual' && !busy" class="text-button" @click="$emit('inspect', item.candidate)">单独处理</button></article></div>
      <p role="status">{{ summary }}</p><button v-if="!busy && items.some(item => item.state === 'failed')" class="button" :disabled="!connected" @click="retryFailed">重试失败项</button>
      <div v-if="confirmStop" class="confirm-warning"><div><strong>停止尚未提交的项目？</strong><p>正在确认的请求会完成确认，已入队任务继续下载。</p><button class="button" @click="confirmStop = false">继续提交</button><button class="button" @click="stop">停止未提交项</button></div></div>
      <div class="dialog-actions"><button class="button" @click="requestClose">{{ busy ? '停止提交' : '关闭' }}</button><button v-if="!submitted" class="button primary" :disabled="!connected || !items.some(item => item.state === 'pending')" @click="submit">确认并排队</button></div>
    </section>
  </div>
</template>
