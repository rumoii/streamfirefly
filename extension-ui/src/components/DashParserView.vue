<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { MediaCandidate, UiContext } from "../types";
import { buildDashPlan, parseDash, type DashManifest, type DashTrack } from "../dash";
import { sendMessage } from "../api";
import { createDownload } from "../download-client";
import { candidatePayload } from "../download-plan";
import { formatDuration } from "../format";
import { humanError } from "../store";

const props = defineProps<{ candidate: MediaCandidate; context: UiContext; capabilities: string[]; saveDir: string; downloadThreads: number; connected?: boolean }>();
const emit = defineEmits<{ back: []; created: [message: string] }>();
const manifest = ref<DashManifest | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const videoId = ref("");
const audioId = ref("");
const container = ref<"mp4" | "mkv">("mp4");
const fileName = ref("");
let sequence = 0;
let requestId = crypto.randomUUID();
let submittedPayload: Record<string, unknown> | null = null;
onBeforeUnmount(() => { sequence++; });
const videos = computed(() => manifest.value?.tracks.filter(track => track.kind === "video") || []);
const audios = computed(() => manifest.value?.tracks.filter(track => track.kind === "audio") || []);
const supported = computed(() => props.capabilities.includes("dash-selection-v1"));
const selection = computed(() => {
  if (!manifest.value) return { plan: null, error: "" };
  try { return { plan: buildDashPlan(manifest.value, videoId.value, audioId.value, container.value), error: "" }; }
  catch (reason) { return { plan: null, error: (reason as Error).message }; }
});
function label(track: DashTrack) { return `${track.kind === "video" ? `${track.width} × ${track.height}` : track.language} · ${Math.round(track.bandwidth / 1000)} kbps · ${track.codecs || "未知编码"}`; }

watch(() => props.candidate, async candidate => {
  const current = ++sequence;
  loading.value = true; error.value = ""; manifest.value = null; submittedPayload = null;
  requestId = crypto.randomUUID(); fileName.value = candidate.title || candidate.pageTitle || "DASH";
  try {
    const inline = candidate.inlineManifest;
    const response = inline ? { ok: true, text: inline.text, url: inline.baseUrl } : await sendMessage({ type: "media.fetchText", tabId: props.context.sourceTabId, id: candidate.id, url: candidate.url });
    if (current !== sequence) return;
    if (!response?.ok) throw new Error(response?.error || "media_fetch_failed");
    manifest.value = parseDash(response.text, response.url || candidate.url);
    videoId.value = [...videos.value].sort((first, second) => second.bandwidth - first.bandwidth)[0]?.id || "";
    audioId.value = (audios.value.find(track => track.main) || audios.value[0])?.id || "";
    container.value = "mp4";
    if (selection.value.error.includes("MKV")) container.value = "mkv";
  } catch (reason) { if (current === sequence) error.value = humanError((reason as Error).message); }
  finally { if (current === sequence) loading.value = false; }
}, { immediate: true });

async function submit() {
  if (busy.value || !supported.value || props.connected === false || !selection.value.plan) return;
  busy.value = true; error.value = "";
  const current = sequence;
  submittedPayload ||= JSON.parse(JSON.stringify({ ...candidatePayload(props.candidate), inlineManifest: null, dashPlan: selection.value.plan, sourceContextId: props.context.sourceContextId, saveDir: props.saveDir || null, downloadThreads: props.downloadThreads, fileName: fileName.value.trim() }));
  try {
    await createDownload(submittedPayload!, requestId);
    if (current === sequence) emit("created", "DASH 下载任务已加入队列");
  } catch (reason) {
    if (current === sequence) {
      const message = (reason as Error).message;
      error.value = humanError(message);
      if (!/提交结果尚未确认|native_host_timeout|native_host_disconnected/.test(message)) { submittedPayload = null; requestId = crypto.randomUUID(); }
    }
  }
  finally { if (current === sequence) busy.value = false; }
}
</script>

<template>
  <section class="parser-page">
    <div class="subpage-heading"><button class="button subtle" type="button" @click="$emit('back')">← 返回资源</button><div><span class="tag">DASH · 实验性</span><h2>媒体解析</h2><p>{{ candidate.pageTitle || candidate.title || candidate.url }}</p></div></div>
    <p class="privacy-hint">仍在完善中的新功能，欢迎尝试并反馈问题。</p>
    <div v-if="error" class="status-banner error" role="alert">{{ error }}</div>
    <div v-if="!supported" class="status-banner warning">请同时更新扩展与本地助手，以使用 DASH 选轨下载。</div>
    <div v-if="loading" class="empty-state" role="status">正在解析 DASH 清单…</div>
    <fieldset v-else-if="manifest" class="dash-selection panel" :disabled="busy || Boolean(submittedPayload)">
      <label><span>视频画质</span><select v-model="videoId" class="control" aria-label="视频画质"><option value="">不下载视频</option><option v-for="track in videos" :key="track.id" :value="track.id">{{ label(track) }}</option></select></label>
      <label><span>音轨</span><select v-model="audioId" class="control" aria-label="音轨"><option value="">不下载音频</option><option v-for="track in audios" :key="track.id" :value="track.id">{{ label(track) }}</option></select></label>
      <label><span>输出容器</span><select v-model="container" class="control" aria-label="输出容器"><option value="mp4">MP4</option><option value="mkv">MKV</option></select></label>
      <label><span>文件名</span><input v-model="fileName" class="control" maxlength="100" aria-label="文件名"></label>
    </fieldset>
    <div v-if="selection.error" class="status-banner error" role="alert">{{ selection.error }}</div>
    <section v-if="manifest" class="download-summary panel">
      <div><strong>{{ fileName }}.{{ container }}</strong><small>{{ saveDir || '系统默认下载目录' }}</small></div>
      <div class="summary-pills"><span>{{ formatDuration(manifest.duration) }}</span><span>{{ selection.plan?.tracks.reduce((total, track) => total + track.segments.length, 0) || 0 }} 个分片</span><span>无转码合并</span></div>
      <button class="button primary large" type="button" :disabled="busy || connected === false || !supported || !selection.plan || !fileName.trim()" @click="submit">{{ busy ? '正在提交…' : submittedPayload ? '重试同一提交' : '开始下载' }}</button>
    </section>
  </section>
</template>
