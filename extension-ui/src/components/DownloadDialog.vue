<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import type { MediaCandidate } from "../types";
import { sendMessage } from "../api";
import { humanError } from "../store";
import { defaultAudio, defaultVariant, deriveMediaPlaylist, parseHls } from "../media";

const props = defineProps<{ candidate: MediaCandidate | null; saveDir: string; downloadThreads: number; sourceContextId: string | null; sourceTabId: number | null; capabilities: string[] }>();
const emit = defineEmits<{ close: []; created: [message: string] }>();
const form = reactive({ name: "", extension: "mp4", busy: false, error: "" });
let preparedHlsPlan: any = null;

function payload(extra: Record<string, any> = {}) {
  const item = props.candidate!;
  return { url: item.url, title: item.title || item.pageTitle || "streamfirefly-download", mime: item.mime || null, contentDisposition: item.contentDisposition || null, referer: item.referer || item.pageUrl || null, requestHeaders: item.requestHeaders || {}, inlineManifest: item.inlineManifest || null, downloadThreads: props.downloadThreads, sourceContextId: props.sourceContextId, ...extra };
}

async function fetchManifest(url: string) {
  const item = props.candidate!;
  if (item.inlineManifest && url === item.url) return { text: item.inlineManifest.text, url: item.inlineManifest.baseUrl || item.url };
  const result: any = await sendMessage({ type: "media.fetchText", tabId: props.sourceTabId, id: item.id, url });
  if (!result?.ok) throw new Error(result?.error || "media_fetch_failed");
  return { text: result.text, url: result.url || url };
}

async function prepareQuickHls() {
  if (!props.capabilities.includes("hls-selection-v1")) throw new Error("hls_selection_native_upgrade_required");
  const root = await fetchManifest(props.candidate!.url);
  const master = parseHls(root.text, root.url);
  if (master.live) throw new Error("Beta 1 暂不支持直播下载，请使用解析页面查看清单");
  const variant = defaultVariant(master.variants);
  const mediaResponse = variant ? await fetchManifest(variant.uri) : root;
  const media = parseHls(mediaResponse.text, mediaResponse.url);
  if (media.live) throw new Error("Beta 1 暂不支持直播下载，请使用解析页面查看清单");
  const selected = deriveMediaPlaylist(media, 0, media.segments.length - 1);
  const audioTrack = variant ? defaultAudio(master.tracks, variant.audioGroup) : null;
  let audioManifest = null;
  if (audioTrack?.uri) {
    const audioResponse = await fetchManifest(audioTrack.uri);
    const audio = parseHls(audioResponse.text, audioResponse.url);
    const derived = deriveMediaPlaylist(audio, 0, audio.segments.length - 1);
    audioManifest = { format: "hls", baseUrl: derived.baseUrl, text: derived.text };
  }
  const container = !variant?.codecs || /avc1|hvc1|hev1|mp4a/i.test(variant.codecs) ? "mp4" : "mkv";
  preparedHlsPlan = { version: 1, duration: selected.actualEnd - selected.actualStart, container, range: { requestedStart: 0, requestedEnd: selected.actualEnd, actualStart: selected.actualStart, actualEnd: selected.actualEnd, firstSegment: selected.first, lastSegment: selected.last }, videoManifest: { format: "hls", baseUrl: selected.baseUrl, text: selected.text }, audioManifest, subtitles: [] };
  form.extension = container;
}

watch(() => props.candidate, async candidate => {
  form.error = "";
  preparedHlsPlan = null;
  if (!candidate) return;
  try {
    if (candidate.type === "hls") await prepareQuickHls();
    const result: any = await sendMessage({ type: "task.prepare", payload: payload(preparedHlsPlan ? { hlsPlan: preparedHlsPlan, inlineManifest: null } : {}) });
    if (!result?.ok) throw new Error(result?.error || "task_prepare_failed");
    form.name = result.payload.fileName;
    form.extension = result.payload.extension;
  } catch (reason: any) { form.error = humanError(reason?.message); }
}, { immediate: true });

const validation = computed(() => {
  const value = form.name.trim().replace(/[. ]+$/g, "");
  if (!value) return "请输入文件名称";
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(value)) return "文件名不能包含 Windows 非法字符";
  return "";
});

async function create() {
  if (!props.candidate || validation.value) return;
  form.busy = true; form.error = "";
  try {
    const result: any = await sendMessage({ type: "task.create", payload: { ...payload(preparedHlsPlan ? { hlsPlan: preparedHlsPlan, inlineManifest: null } : {}), fileName: form.name.trim(), saveDir: props.saveDir || null } });
    if (!result?.ok) throw new Error(result?.error || "task_create_failed");
    emit("created", `任务已创建：${result.task?.title || form.name}`);
    emit("close");
  } catch (reason: any) { form.error = humanError(reason?.message); }
  finally { form.busy = false; }
}
</script>

<template>
  <Transition name="fade">
    <div v-if="candidate" class="dialog-backdrop" @click.self="$emit('close')">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="download-title">
        <div class="dialog-heading"><div><h2 id="download-title">开始下载</h2><p>确认文件名称与保存位置</p></div><button class="icon-button" type="button" aria-label="关闭" @click="$emit('close')">×</button></div>
        <label class="field"><span>文件名称</span><div class="filename"><input v-model="form.name" maxlength="100" @keydown.enter="create"><b>.{{ form.extension }}</b></div><small class="error-text">{{ validation || form.error }}</small></label>
        <div class="path-summary"><span>保存目录</span><strong>{{ saveDir || '系统默认目录' }}</strong></div>
        <div class="dialog-actions"><button class="button" type="button" @click="$emit('close')">取消</button><button class="button primary" type="button" :disabled="Boolean(validation) || form.busy" @click="create">{{ form.busy ? '正在创建…' : '开始下载' }}</button></div>
      </section>
    </div>
  </Transition>
</template>
