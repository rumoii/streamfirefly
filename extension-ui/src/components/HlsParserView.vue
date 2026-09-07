<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import type { MediaCandidate, UiContext } from "../types";
import { chooseHlsContainer, defaultAudio, defaultVariant, deriveMediaPlaylist, hlsEncryptionMethods, parseHls, segmentRangeForTime, validateHlsKeyOverride, type HlsKeyOverrideKind, type HlsManifest, type HlsTrack } from "../media";
import { formatDuration } from "../format";
import { extensionApi, sendMessage } from "../api";
import { humanError } from "../store";
import { buildHlsPlan } from "../download-plan";
import { createDownload } from "../download-client";
const requestId = ref(crypto.randomUUID());

const props = defineProps<{ candidate: MediaCandidate; context: UiContext; capabilities: string[]; saveDir: string; downloadThreads: number; connected?: boolean }>();
const emit = defineEmits<{ back: []; created: [message: string] }>();
const loading = ref(true);
const error = ref("");
const master = ref<HlsManifest | null>(null);
const videoManifest = ref<HlsManifest | null>(null);
const selectedVariantId = ref("");
const selectedAudioId = ref("");
const selectedSubtitleIds = ref<string[]>([]);
const rangeMode = ref<"all" | "time" | "segment">("all");
const range = reactive({ startTime: 0, endTime: 0, first: 0, last: 0 });
const form = reactive({ name: "", extension: "mp4", container: "mp4", busy: false });
const keyMode = ref<"auto" | "manual">("auto");
const keyForm = reactive<{ kind: HlsKeyOverrideKind; value: string; iv: string }>({ kind: "hex", value: "", iv: "" });
const trackManifests = new Map<string, HlsManifest>();
let variantSequence = 0;
let disposed = false;
onBeforeUnmount(() => { disposed = true; variantSequence++; });
const liveSupported = computed(() => props.capabilities.includes("hls-live-engine-v1") || !extensionApi()?.runtime?.sendMessage);
const isLive = computed(() => Boolean(master.value?.live || videoManifest.value?.live));

const variants = computed(() => master.value?.variants || []);
const selectedVariant = computed(() => variants.value.find(item => item.id === selectedVariantId.value) || null);
const audioTracks = computed(() => (master.value?.tracks || []).filter(item => item.type === "AUDIO" && (!selectedVariant.value?.audioGroup || item.groupId === selectedVariant.value.audioGroup) && item.uri));
const subtitleTracks = computed(() => (master.value?.tracks || []).filter(item => item.type === "SUBTITLES" && (!selectedVariant.value?.subtitlesGroup || item.groupId === selectedVariant.value.subtitlesGroup) && item.uri));
const actualRange = computed(() => {
  const manifest = videoManifest.value;
  if (!manifest?.segments.length || manifest.live) return null;
  const first = rangeMode.value === "all" ? 0 : rangeMode.value === "time" ? segmentRangeForTime(manifest, range.startTime, range.endTime)[0] : range.first;
  const last = rangeMode.value === "all" ? manifest.segments.length - 1 : rangeMode.value === "time" ? segmentRangeForTime(manifest, range.startTime, range.endTime)[1] : range.last;
  const derived = deriveMediaPlaylist(manifest, first, last);
  return { ...derived, count: derived.last - derived.first + 1 };
});
const advancedSupported = computed(() => props.capabilities.includes("hls-selection-v1"));
const keyOverrideSupported = computed(() => props.capabilities.includes("hls-key-override-v1"));
const encryptionMethods = computed(() => hlsEncryptionMethods(videoManifest.value));
const unsupportedEncryption = computed(() => encryptionMethods.value.find(method => method !== "AES-128") || "");
const unsupportedLiveFeature = computed(() => videoManifest.value?.hasDrmKeyFormat ? "此直播使用 DRM 密钥格式，流萤不会尝试绕过。" : videoManifest.value?.hasLowLatencyParts ? "此直播使用 LL-HLS Part，Beta 3 暂不支持录制。" : "");
const keyError = computed(() => keyMode.value === "manual" ? validateHlsKeyOverride(keyForm.kind, keyForm.value, keyForm.iv) : "");

async function fetchText(url: string): Promise<{ text: string; url: string }> {
  if (!extensionApi()?.runtime?.sendMessage) return previewManifest(url);
  const result: any = await sendMessage({ type: "media.fetchText", tabId: props.context.sourceTabId, id: props.candidate.id, url });
  if (!result?.ok) throw new Error(result?.error || "media_fetch_failed");
  return { text: result.text, url: result.url || url };
}

async function loadTrack(track: HlsTrack): Promise<HlsManifest> {
  if (!track.uri) throw new Error("轨道没有清单地址");
  if (trackManifests.has(track.id)) return trackManifests.get(track.id)!;
  const response = await fetchText(track.uri);
  const parsed = parseHls(response.text, response.url);
  trackManifests.set(track.id, parsed);
  return parsed;
}

async function loadVariant() {
  const sequence = ++variantSequence;
  const variant = selectedVariant.value;
  if (!variant) return;
  loading.value = true; error.value = "";
  try {
    const response = await fetchText(variant.uri);
    if (disposed || sequence !== variantSequence) return;
    videoManifest.value = parseHls(response.text, response.url);
    resetRange();
    const preferred = defaultAudio(master.value?.tracks || [], variant.audioGroup);
    selectedAudioId.value = preferred?.id || "";
    form.container = chooseHlsContainer(variant.codecs);
    form.extension = form.container;
  } catch (reason: any) { if (!disposed && sequence === variantSequence) error.value = humanError(reason?.message); }
  finally { if (!disposed && sequence === variantSequence) loading.value = false; }
}

function resetRange() {
  const manifest = videoManifest.value;
  range.startTime = 0; range.endTime = manifest?.duration || 0; range.first = 0; range.last = Math.max(0, (manifest?.segments.length || 1) - 1);
}

watch(selectedVariantId, () => { void loadVariant(); });
watch(() => [range.startTime, range.endTime], () => {
  if (rangeMode.value !== "time" || !videoManifest.value) return;
  [range.first, range.last] = segmentRangeForTime(videoManifest.value, range.startTime, range.endTime);
});
watch(() => [range.first, range.last], () => {
  if (rangeMode.value !== "segment" || !videoManifest.value?.segments.length) return;
  const first = videoManifest.value.segments[Math.max(0, Math.min(range.first, videoManifest.value.segments.length - 1))];
  const last = videoManifest.value.segments[Math.max(first.index, Math.min(range.last, videoManifest.value.segments.length - 1))];
  range.startTime = first.start; range.endTime = last.end;
});

async function initialize() {
  loading.value = true; error.value = "";
  try {
    const response = props.candidate.inlineManifest ? { text: props.candidate.inlineManifest.text, url: props.candidate.inlineManifest.baseUrl || props.candidate.url } : await fetchText(props.candidate.url);
    master.value = parseHls(response.text, response.url);
    if (master.value.kind === "master") {
      const preferred = defaultVariant(master.value.variants);
      selectedVariantId.value = preferred?.id || "";
    } else {
      videoManifest.value = master.value;
      resetRange();
    }
    const prepared: any = await sendMessage({ type: "task.prepare", payload: basePayload() }).catch(() => null);
    form.name = prepared?.payload?.fileName || props.candidate.pageTitle || "streamfirefly-media";
  } catch (reason: any) { error.value = humanError(reason?.message); }
  finally { loading.value = false; }
}

function basePayload() {
  return { url: props.candidate.url, candidateId: props.candidate.id, title: props.candidate.title || props.candidate.pageTitle || "streamfirefly-media", mime: props.candidate.mime || "application/vnd.apple.mpegurl", referer: props.candidate.referer || props.candidate.pageUrl || null, requestHeaders: props.candidate.requestHeaders || {}, downloadThreads: props.downloadThreads, sourceContextId: props.context.sourceContextId };
}

async function createTask() {
  if (!videoManifest.value || !advancedSupported.value || props.connected === false || loading.value || form.busy || disposed) return;
  if (isLive.value && !liveSupported.value) { error.value = "请同时更新扩展与本地助手后录制直播。"; return; }
  if (unsupportedLiveFeature.value) { error.value = unsupportedLiveFeature.value; return; }
  if (unsupportedEncryption.value) { error.value = `暂不支持 ${unsupportedEncryption.value} 加密；流萤不会绕过 DRM。`; return; }
  if (keyMode.value === "manual" && (!keyOverrideSupported.value || keyError.value)) { error.value = keyError.value || "当前本地助手不支持自定义密钥"; return; }
  form.busy = true; error.value = "";
  try {
    const audio = audioTracks.value.find(item => item.id === selectedAudioId.value);
    const audioManifest = audio ? await loadTrack(audio) : null;
    const subtitles = await Promise.all(selectedSubtitleIds.value.map(async id => {
      const track = subtitleTracks.value.find(item => item.id === id)!;
      return { id: track.id, language: track.language || null, label: track.name, manifest: await loadTrack(track) };
    }));
    const hlsPlan = await buildHlsPlan({ video: videoManifest.value, audio: audioManifest, subtitles, container: form.container, first: actualRange.value?.first, last: actualRange.value?.last, requestedStart: range.startTime, requestedEnd: range.endTime, keyOverride: keyMode.value === "manual" ? { kind: keyForm.kind, value: keyForm.value.trim(), iv: keyForm.iv.trim() || null } : null });
    const task = await createDownload({ ...basePayload(), fileName: form.name.trim(), saveDir: props.saveDir || null, hlsPlan }, requestId.value);
    const result = { task };
    requestId.value = crypto.randomUUID();
    emit("created", `HLS 任务已创建：${result.task?.title || form.name}`);
  } catch (reason: any) { error.value = humanError(reason?.message); }
  finally { form.busy = false; }
}

onMounted(initialize);

function previewManifest(url: string) {
  if (url.includes("1080")) return { url, text: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://media.example/v1.ts\n#EXTINF:6,\nhttps://media.example/v2.ts\n#EXTINF:6,\nhttps://media.example/v3.ts\n#EXT-X-ENDLIST` };
  if (url.includes("720")) return { url, text: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://media.example/720-1.ts\n#EXTINF:6,\nhttps://media.example/720-2.ts\n#EXT-X-ENDLIST` };
  if (url.includes("audio")) return { url, text: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://media.example/a1.aac\n#EXTINF:6,\nhttps://media.example/a2.aac\n#EXTINF:6,\nhttps://media.example/a3.aac\n#EXT-X-ENDLIST` };
  if (url.includes("sub")) return { url, text: `#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nhttps://media.example/s1.vtt\n#EXTINF:6,\nhttps://media.example/s2.vtt\n#EXTINF:6,\nhttps://media.example/s3.vtt\n#EXT-X-ENDLIST` };
  return { url, text: `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="默认音轨",LANGUAGE="zh-CN",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="中文字幕",LANGUAGE="zh-CN",URI="sub.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio",SUBTITLES="subs"\n1080.m3u8` };
}
</script>

<template>
  <section class="parser-page">
    <div class="subpage-heading"><button class="button subtle" type="button" @click="$emit('back')">← 返回资源</button><div><span class="tag">HLS</span><h2>媒体解析</h2><p>{{ candidate.pageTitle || candidate.title || candidate.url }}</p></div></div>
    <div v-if="error" class="status-banner error">{{ error }}</div>
    <div v-if="isLive" class="status-banner warning"><strong>检测到直播清单</strong><span>流萤会持续获取新增切片；结束时点击“停止并保存”，或等待直播清单自然结束。</span></div>
    <div v-if="unsupportedLiveFeature" class="status-banner error"><strong>暂不支持录制</strong><span>{{ unsupportedLiveFeature }}</span></div>
    <div v-if="!advancedSupported" class="status-banner warning"><strong>需要成套升级</strong><span>请同时更新扩展与本地助手后按选择下载 HLS。</span></div>
    <div class="parser-grid">
      <section class="panel parser-options">
        <div class="panel-title"><div><h3>画质与轨道</h3><p>选择最终保存的媒体内容</p></div></div>
        <div v-if="loading" class="option-skeleton"><i v-for="i in 5" :key="i"></i></div>
        <template v-else>
          <fieldset v-if="variants.length" class="choice-group"><legend>清晰度</legend><label v-for="variant in variants" :key="variant.id" class="choice-card"><input v-model="selectedVariantId" type="radio" :value="variant.id"><span><strong>{{ variant.width && variant.height ? `${variant.width} × ${variant.height}` : '自适应画质' }}</strong><small>{{ variant.averageBandwidth || variant.bandwidth ? `${Math.round((variant.averageBandwidth || variant.bandwidth || 0) / 1000)} Kbps` : '码率未知' }} · {{ variant.codecs || '编码未知' }}</small></span></label></fieldset>
          <fieldset v-if="audioTracks.length" class="choice-group"><legend>音轨</legend><label v-for="track in audioTracks" :key="track.id" class="choice-card"><input v-model="selectedAudioId" type="radio" :value="track.id"><span><strong>{{ track.name }}</strong><small>{{ track.language || '语言未知' }}{{ track.isDefault ? ' · 默认' : '' }}</small></span></label></fieldset>
          <fieldset v-if="subtitleTracks.length" class="choice-group"><legend>字幕（可多选）</legend><label v-for="track in subtitleTracks" :key="track.id" class="choice-card"><input v-model="selectedSubtitleIds" type="checkbox" :value="track.id"><span><strong>{{ track.name }}</strong><small>{{ track.language || '语言未知' }} · 独立字幕文件</small></span></label></fieldset>
          <div v-if="!subtitleTracks.length" class="muted-box">此清单没有声明可选字幕。</div>
        </template>
      </section>

      <section class="panel parser-range">
        <div class="panel-title"><div><h3>切片与时间范围</h3><p>范围按完整切片边界执行</p></div><span v-if="videoManifest" class="tag">{{ videoManifest.segments.length }} 个切片</span></div>
        <div v-if="!isLive" class="range-tabs"><button v-for="mode in [['all','全部'],['time','按时间'],['segment','按切片']]" :key="mode[0]" type="button" :class="{ active: rangeMode === mode[0] }" @click="rangeMode = mode[0] as any">{{ mode[1] }}</button></div>
        <div v-if="videoManifest && !isLive" class="range-body">
          <div class="timeline"><i v-for="segment in videoManifest.segments.slice(0, 160)" :key="segment.index" :class="{ selected: actualRange && segment.index >= actualRange.first && segment.index <= actualRange.last }" :style="{ flexGrow: Math.max(.2, segment.duration) }"></i></div>
          <div v-if="rangeMode === 'time'" class="range-inputs"><label><span>开始时间（秒）</span><input v-model.number="range.startTime" class="control" type="number" min="0" :max="videoManifest.duration" step="0.1"></label><label><span>结束时间（秒）</span><input v-model.number="range.endTime" class="control" type="number" :min="range.startTime" :max="videoManifest.duration" step="0.1"></label></div>
          <div v-if="rangeMode === 'segment'" class="range-inputs"><label><span>起始切片</span><input v-model.number="range.first" class="control" type="number" min="0" :max="videoManifest.segments.length - 1"></label><label><span>结束切片</span><input v-model.number="range.last" class="control" type="number" :min="range.first" :max="videoManifest.segments.length - 1"></label></div>
          <dl v-if="actualRange" class="range-summary"><div><dt>清单总时长</dt><dd>{{ formatDuration(videoManifest.duration) }}</dd></div><div><dt>实际下载范围</dt><dd>{{ formatDuration(actualRange.actualStart) }} — {{ formatDuration(actualRange.actualEnd) }}</dd></div><div><dt>实际切片</dt><dd>#{{ actualRange.first }} — #{{ actualRange.last }}（{{ actualRange.count }} 个）</dd></div><div><dt>预计时长</dt><dd>{{ formatDuration(actualRange.actualEnd - actualRange.actualStart) }}</dd></div></dl>
        </div>
        <div v-else-if="isLive" class="empty-state"><span>●</span><h3>直播录制模式</h3><p>当前窗口已有 {{ videoManifest?.segments.length || 0 }} 个切片；开始后会自动轮询并去重保存。</p></div>
        <div v-else-if="!loading" class="empty-state"><span>⌁</span><h3>没有可用切片</h3><p>此清单没有可下载的完整媒体切片。</p></div>
      </section>
    </div>
    <details class="panel encryption-panel">
      <summary><span><strong>加密与密钥</strong><small>{{ encryptionMethods.length ? `检测到 ${encryptionMethods.join('、')}` : '当前所选画质未检测到加密' }}</small></span><i>⌄</i></summary>
      <div class="encryption-body">
        <div v-if="unsupportedEncryption" class="status-banner error"><strong>不支持 {{ unsupportedEncryption }}</strong><span>仅支持标准 AES-128；SAMPLE-AES 与 DRM 只识别，不尝试绕过。</span></div>
        <label class="choice-card compact"><input v-model="keyMode" type="radio" value="auto"><span><strong>自动使用清单密钥</strong><small>按照 #EXT-X-KEY 获取密钥，并在批量下载前验证首个加密切片。</small></span></label>
        <label class="choice-card compact" :class="{ disabled: !keyOverrideSupported }"><input v-model="keyMode" type="radio" value="manual" :disabled="!keyOverrideSupported"><span><strong>手动指定 AES-128 密钥</strong><small>密钥仅保存在本次 Native Host 进程内，不写入任务记录或检查点。</small></span></label>
        <div v-if="keyMode === 'manual'" class="key-form">
          <label><span>密钥格式</span><select v-model="keyForm.kind" class="control"><option value="hex">Hex</option><option value="base64">Base64</option><option value="url">密钥 URL</option></select></label>
          <label class="key-value"><span>{{ keyForm.kind === 'url' ? '密钥地址' : '密钥内容' }}</span><input v-model="keyForm.value" class="control" autocomplete="off" :placeholder="keyForm.kind === 'hex' ? '32 位十六进制' : keyForm.kind === 'base64' ? '解码后 16 字节' : 'https://example.com/key.bin'"></label>
          <label><span>自定义 IV（可选）</span><input v-model="keyForm.iv" class="control" autocomplete="off" placeholder="32 位十六进制"></label>
          <p v-if="keyError" class="inline-error">{{ keyError }}</p>
        </div>
      </div>
    </details>
    <section class="download-summary panel">
      <div><span>输出文件</span><div class="filename"><input v-model="form.name" maxlength="100"><b>.{{ form.extension }}</b></div><small>{{ saveDir || '系统默认下载目录' }}</small></div>
      <div class="summary-pills"><span>{{ selectedVariant?.height ? `${selectedVariant.height}P` : '原始画质' }}</span><span>{{ audioTracks.find(item => item.id === selectedAudioId)?.name || '内嵌音轨' }}</span><span>{{ selectedSubtitleIds.length }} 条字幕</span><span>{{ form.container.toUpperCase() }} 无转码</span></div>
      <button class="button primary large" type="button" :disabled="connected === false || loading || !videoManifest || !advancedSupported || (isLive && !liveSupported) || Boolean(unsupportedLiveFeature) || Boolean(unsupportedEncryption) || Boolean(keyError) || form.busy || !form.name.trim()" @click="createTask">{{ form.busy ? '正在创建任务…' : isLive ? '开始录制直播' : '开始可靠下载' }}</button>
    </section>
  </section>
</template>
