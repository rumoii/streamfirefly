<script setup lang="ts">
import { copyResources } from "../features/configuration/copy";
import Hls from "hls.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { MediaCandidate, ResourceViewState } from "../types";
import { filterCandidates, sortCandidates } from "../media";
import { formatBytes, formatDuration, sourceLabel, typeLabel } from "../format";
import { sendMessage } from "../api";

type PreviewState = "idle" | "preparing" | "ready" | "playing" | "failed";

const props = defineProps<{ candidates: MediaCandidate[]; loading: boolean; viewState: ResourceViewState; compact?: boolean; connected?: boolean }>();
const emit = defineEmits<{
  download: [candidate: MediaCandidate];
  batchDownload: [candidates: MediaCandidate[]];
  parse: [candidate: MediaCandidate];
  remove: [ids: string[]];
  updateViewState: [patch: Partial<Omit<ResourceViewState, "revision">>];
  metadata: [candidate: MediaCandidate, metadata: Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">>];
}>();
const selectedIds = ref(new Set<string>());
const previewState = ref<PreviewState>("idle");
const previewError = ref("");
const mediaElement = ref<HTMLVideoElement | HTMLAudioElement | null>(null);
const resourceScroll = ref<HTMLElement | null>(null);
const previewSessionId = `preview-${crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
let savedScrollTop = 0;
let hls: Hls | null = null;
let activePreviewId = "";
let preparationToken = 0;
let autoPreparing = false;
let networkRecoveries = 0;
let mediaRecoveries = 0;
let lastMetadataSignature = "";
let preparationTimer = 0;

const resourceCandidates = computed(() => props.candidates.filter(item => item.type !== "segment"));
const filtered = computed(() => filterCandidates(resourceCandidates.value, props.viewState.pattern, props.viewState.type, props.viewState.minMb, props.viewState.maxMb, props.viewState.minDuration, props.viewState.maxDuration));
const visible = computed(() => sortCandidates(filtered.value.items, props.viewState.sortMode));
const expanded = computed(() => visible.value.find(item => item.id === props.viewState.expandedId) || null);
const segments = computed(() => props.candidates.filter(item => item.type === "segment"));

watch(visible, items => {
  selectedIds.value = new Set([...selectedIds.value].filter(id => items.some(item => item.id === id)));
  if (props.viewState.expandedId && !items.some(item => item.id === props.viewState.expandedId)) emit("updateViewState", { expandedId: "" });
});

watch(() => props.viewState.expandedId, async (next, previous) => {
  if (next === previous) return;
  await disposePreview();
  if (!next || props.compact || props.viewState.collapsed) return;
  await nextTick();
  const item = expanded.value;
  if (item && item.id === next && item.type !== "image") await preparePreview(item);
}, { immediate: true });

watch(() => props.viewState.collapsed, async collapsed => {
  if (props.compact) return;
  if (collapsed) {
    await disposePreview();
    return;
  }
  await nextTick();
  if (expanded.value) await preparePreview(expanded.value);
});

function updateViewState<K extends keyof Omit<ResourceViewState, "revision">>(key: K, value: ResourceViewState[K]) {
  emit("updateViewState", { [key]: value } as Partial<Omit<ResourceViewState, "revision">>);
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedIds.value = next;
}

function selectAll() { selectedIds.value = selectedIds.value.size === visible.value.length ? new Set() : new Set(visible.value.map(item => item.id)); }
function resourceName(item: MediaCandidate) { try { return item.title || item.pageTitle || new URL(item.url).pathname.split("/").pop() || "未命名资源"; } catch { return item.title || item.pageTitle || "未命名资源"; } }
function resourceMeta(item: MediaCandidate) { return [typeLabel(item.type), item.sizeKind === "manifest" ? "最终大小未知" : formatBytes(item.size), item.width && item.height ? `${item.width}×${item.height}` : null, item.duration ? formatDuration(item.duration) : null, item.live ? "直播" : null, sourceLabel(item.source)].filter(Boolean).join(" · "); }
function copyUrl(value: string) { const candidate = props.candidates.find(item => item.url === value); if (candidate) void copyResources([candidate]).catch(error => { previewError.value = error.message; }); }
function setMediaElement(value: unknown) { mediaElement.value = typeof HTMLMediaElement !== "undefined" && value instanceof HTMLMediaElement ? value as HTMLVideoElement | HTMLAudioElement : null; }

async function copySelected() {
  const items = resourceCandidates.value.filter(item => selectedIds.value.has(item.id));
  try { await copyResources(items); } catch (error) { previewError.value = error instanceof Error ? error.message : "复制失败"; }
}

function toggleDetails(item: MediaCandidate) {
  updateViewState("expandedId", props.viewState.expandedId === item.id ? "" : item.id);
}

async function toggleList() {
  if (!props.viewState.collapsed) {
    savedScrollTop = resourceScroll.value?.scrollTop || 0;
    updateViewState("collapsed", true);
    return;
  }
  updateViewState("collapsed", false);
  await nextTick();
  if (resourceScroll.value) resourceScroll.value.scrollTop = savedScrollTop;
}

async function applyPreviewHeaders(item: MediaCandidate) {
  await sendMessage({ type: "preview.headers.apply", payload: { previewSessionId, candidateId: item.id, url: item.url, headers: item.requestHeaders || {} } }).catch(() => {});
}

async function clearPreviewHeaders() {
  await sendMessage({ type: "preview.headers.clear", previewSessionId }).catch(() => {});
}

function reportMetadata(item: MediaCandidate, extra: Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">> = {}) {
  const media = mediaElement.value;
  const metadata = {
    duration: Number.isFinite(media?.duration) && Number(media?.duration) > 0 ? Number(media?.duration) : extra.duration,
    width: media instanceof HTMLVideoElement && media.videoWidth > 0 ? media.videoWidth : extra.width,
    height: media instanceof HTMLVideoElement && media.videoHeight > 0 ? media.videoHeight : extra.height,
    poster: extra.poster,
    live: extra.live
  };
  const useful = Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null && value !== 0));
  const signature = `${item.id}:${JSON.stringify(useful)}`;
  if (Object.keys(useful).length && signature !== lastMetadataSignature) {
    lastMetadataSignature = signature;
    emit("metadata", item, useful);
  }
}

function captureCurrentFrame(): string | undefined {
  const media = mediaElement.value;
  if (!(media instanceof HTMLVideoElement) || !media.videoWidth || !media.videoHeight) return;
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 640 / media.videoWidth);
    canvas.width = Math.max(1, Math.round(media.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(media.videoHeight * scale));
    canvas.getContext("2d")?.drawImage(media, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .82);
  } catch (_) { return; }
}

async function finishPreparation(item: MediaCandidate, token: number) {
  if (token !== preparationToken || activePreviewId !== item.id) return;
  clearTimeout(preparationTimer);
  preparationTimer = 0;
  const media = mediaElement.value;
  if (!media) return;
  if (!item.poster && media instanceof HTMLVideoElement) {
    autoPreparing = true;
    media.muted = true;
    try {
      await media.play();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    } catch (_) {}
    media.pause();
    autoPreparing = false;
  }
  hls?.stopLoad();
  reportMetadata(item, { poster: item.poster || captureCurrentFrame(), live: item.live });
  previewState.value = "ready";
}

function handleHlsError(item: MediaCandidate, data: any) {
  if (!data?.fatal || activePreviewId !== item.id) return;
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRecoveries < 1) {
    networkRecoveries += 1;
    hls?.startLoad();
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 1) {
    mediaRecoveries += 1;
    hls?.recoverMediaError();
    return;
  }
  clearTimeout(preparationTimer);
  preparationTimer = 0;
  previewState.value = "failed";
  previewError.value = "无法准备此 HLS 资源的预览，请检查来源页面是否仍可播放。";
}

async function preparePreview(item: MediaCandidate) {
  if (activePreviewId === item.id && ["preparing", "ready", "playing"].includes(previewState.value)) return;
  if (hls) { hls.destroy(); hls = null; }
  const token = ++preparationToken;
  activePreviewId = item.id;
  networkRecoveries = 0;
  mediaRecoveries = 0;
  lastMetadataSignature = "";
  previewError.value = "";
  previewState.value = "preparing";
  clearTimeout(preparationTimer);
  preparationTimer = window.setTimeout(() => {
    if (token !== preparationToken || activePreviewId !== item.id || previewState.value !== "preparing") return;
    previewState.value = "failed";
    previewError.value = "预览准备超时，请确认来源页面仍可访问该媒体。";
    hls?.stopLoad();
  }, 15000);
  await nextTick();
  const media = mediaElement.value;
  if (!media || token !== preparationToken) return;
  await applyPreviewHeaders(item);
  media.preload = "auto";
  media.muted = true;
  if (item.type === "hls" && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false, autoStartLoad: true, startPosition: 0, maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 0, maxBufferSize: 10 * 1024 * 1024 });
    hls.on(Hls.Events.ERROR, (_, data) => handleHlsError(item, data));
    hls.on(Hls.Events.LEVEL_LOADED, (_, data: any) => reportMetadata(item, { duration: data?.details?.totalduration, live: Boolean(data?.details?.live) }));
    hls.on(Hls.Events.MANIFEST_PARSED, (_, data: any) => {
      const level = [...(data?.levels || [])].sort((a: any, b: any) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0))[0];
      reportMetadata(item, { width: level?.width, height: level?.height });
    });
    hls.attachMedia(media);
    hls.loadSource(item.url);
  } else {
    media.src = item.url;
    media.load();
  }
}

async function startPreview() {
  const item = expanded.value;
  if (!item) return;
  if (previewState.value === "idle" || previewState.value === "failed") await preparePreview(item);
  await nextTick();
  const media = mediaElement.value;
  if (!media) return;
  previewError.value = "";
  hls?.startLoad(-1);
  media.muted = false;
  try {
    await media.play();
    previewState.value = "playing";
  } catch (_) {
    previewState.value = "ready";
    previewError.value = "浏览器阻止了播放，请使用播放器中的播放按钮重试。";
  }
}

function onMediaMetadata() {
  const item = expanded.value;
  if (!item || activePreviewId !== item.id) return;
  reportMetadata(item);
  if (item.poster && previewState.value === "preparing") void finishPreparation(item, preparationToken);
}

function onMediaData() {
  const item = expanded.value;
  if (!item || activePreviewId !== item.id || previewState.value !== "preparing") return;
  void finishPreparation(item, preparationToken);
}

function onMediaPlay() {
  if (autoPreparing) return;
  hls?.startLoad(-1);
  previewState.value = "playing";
}

function onMediaPause() {
  if (autoPreparing || previewState.value !== "playing") return;
  hls?.stopLoad();
  previewState.value = "ready";
}

async function disposePreview() {
  preparationToken += 1;
  clearTimeout(preparationTimer);
  preparationTimer = 0;
  activePreviewId = "";
  autoPreparing = false;
  hls?.destroy();
  hls = null;
  if (mediaElement.value) {
    mediaElement.value.pause();
    mediaElement.value.removeAttribute("src");
    mediaElement.value.load();
  }
  previewState.value = "idle";
  previewError.value = "";
  await clearPreviewHeaders();
}

onBeforeUnmount(() => { void disposePreview(); });
</script>

<template>
  <section class="resource-layout expandable-resources" :class="{ compact }">
    <div class="resource-list-panel panel">
      <div class="panel-title">
        <div><h2>发现资源</h2><p>{{ resourceCandidates.length }} 个媒体资源<span v-if="segments.length"> · {{ segments.length }} 个分片已收起</span></p></div>
        <div class="panel-title-actions"><span class="live-dot">实时</span><button class="collapse-button" type="button" :aria-expanded="!viewState.collapsed" @click="toggleList">{{ viewState.collapsed ? '展开资源' : '收起资源' }}<i></i></button></div>
      </div>
      <Transition name="panel-collapse">
        <div v-if="!viewState.collapsed" class="resource-panel-content">
          <div class="toolbar-grid">
            <input :value="viewState.pattern" class="control search" type="search" placeholder="正则筛选名称、URL 或 MIME" @input="updateViewState('pattern', ($event.target as HTMLInputElement).value)">
            <select :value="viewState.type" class="control" @change="updateViewState('type', ($event.target as HTMLSelectElement).value as ResourceViewState['type'])"><option value="all">全部类型</option><option value="video">视频与流媒体</option><option value="audio">音频</option><option value="image">图片</option></select>
            <select :value="viewState.sortMode" class="control" @change="updateViewState('sortMode', ($event.target as HTMLSelectElement).value as ResourceViewState['sortMode'])"><option value="detected">嗅探顺序</option><option value="size">文件大小</option><option value="duration">媒体时长</option><option value="type">类型分组</option></select>
            <div class="range-controls"><input :value="viewState.minMb" class="control" type="number" min="0" placeholder="最小 MB" @input="updateViewState('minMb', ($event.target as HTMLInputElement).value)"><span>—</span><input :value="viewState.maxMb" class="control" type="number" min="0" placeholder="最大 MB" @input="updateViewState('maxMb', ($event.target as HTMLInputElement).value)"></div>
          </div>
          <div class="sort-hint">提示：视频资源通常体积较大，按文件大小排序可以更快找到视频。</div>
          <div v-if="filtered.error" class="inline-error">{{ filtered.error }}</div>
          <div class="filter-row"><input :value="viewState.minDuration" class="control" type="number" min="0" aria-label="最短时长（秒）" placeholder="最短时长（秒）" @input="updateViewState('minDuration', ($event.target as HTMLInputElement).value)"><input :value="viewState.maxDuration" class="control" type="number" min="0" aria-label="最长时长（秒）" placeholder="最长时长（秒）" @input="updateViewState('maxDuration', ($event.target as HTMLInputElement).value)"></div>
          <div v-if="visible.length" class="batch-bar"><label><input type="checkbox" :checked="selectedIds.size === visible.length" @change="selectAll"> 全选当前结果</label><span>已选 {{ selectedIds.size }} 项</span><div><button class="text-button" :disabled="!selectedIds.size || connected === false" @click="$emit('batchDownload', visible.filter(item => selectedIds.has(item.id)))">批量下载</button><button class="text-button" :disabled="!selectedIds.size" @click="copySelected">复制</button><button class="text-button danger" :disabled="!selectedIds.size" @click="$emit('remove', [...selectedIds])">移除</button></div></div>
          <div ref="resourceScroll" class="resource-scroll resource-cards">
            <template v-if="loading"><article v-for="index in 3" :key="index" class="resource-card skeleton-card"><i></i><div><b></b><span></span></div></article></template>
            <article v-for="item in visible" v-else :key="item.id" class="resource-card" :class="{ expanded: !compact && viewState.expandedId === item.id }">
              <div class="resource-summary">
                <label class="resource-select"><input type="checkbox" :checked="selectedIds.has(item.id)" :aria-label="`选择${resourceName(item)}`" @change="toggleSelection(item.id)"></label>
                <span class="resource-type">{{ typeLabel(item.type) }}</span>
                <span class="resource-identity"><strong>{{ resourceName(item) }}</strong><small>{{ resourceMeta(item) }}</small><em>{{ item.url }}</em></span>
                <span class="card-actions"><button v-if="item.type === 'hls' || item.type === 'dash'" class="button subtle" type="button" @click="$emit('parse', item)">{{ compact ? '详细解析' : '解析' }}</button><button v-if="!compact" class="button subtle" type="button" :aria-expanded="viewState.expandedId === item.id" @click="toggleDetails(item)">{{ viewState.expandedId === item.id ? '收起' : '详情' }}</button><button class="button primary" type="button" :disabled="connected === false" @click="$emit('download', item)">{{ compact && item.type === 'hls' ? '快速下载' : '下载' }}</button></span>
              </div>
              <Transition name="resource-detail">
                <div v-if="!compact && viewState.expandedId === item.id" class="expanded-detail"><div class="expanded-detail-inner">
                  <div class="expanded-preview" :class="{ image: item.type === 'image' }">
                    <img v-if="item.type === 'image'" :src="item.url" alt="资源预览">
                    <video v-else-if="['video','hls','dash'].includes(item.type)" :ref="setMediaElement" controls preload="auto" playsinline :poster="item.poster || undefined" @loadedmetadata="onMediaMetadata" @durationchange="onMediaMetadata" @loadeddata="onMediaData" @play="onMediaPlay" @pause="onMediaPause"></video>
                    <audio v-else-if="item.type === 'audio'" :ref="setMediaElement" controls preload="auto" @loadedmetadata="onMediaMetadata" @durationchange="onMediaMetadata" @loadeddata="onMediaData" @play="onMediaPlay" @pause="onMediaPause"></audio>
                    <div v-if="previewState === 'preparing' && item.type !== 'image'" class="preview-status" :class="{ 'has-poster': item.poster }"><i></i><strong>正在准备封面与媒体信息</strong><span>只加载预览所需的少量数据</span></div>
                    <button v-if="(previewState === 'ready' || previewState === 'preparing' && item.poster) && item.type !== 'image'" class="preview-play" type="button" @click="startPreview"><span>▶</span><strong>播放预览</strong></button>
                  </div>
                  <div class="expanded-info">
                    <dl class="detail-grid"><div><dt>文件大小</dt><dd>{{ item.sizeKind === 'manifest' ? '最终大小未知' : formatBytes(item.size) }}</dd></div><div><dt>分辨率</dt><dd>{{ item.width && item.height ? `${item.width} × ${item.height}` : '未知' }}</dd></div><div><dt>媒体时长</dt><dd>{{ formatDuration(item.duration) }}</dd></div><div><dt>媒体状态</dt><dd>{{ item.live ? '直播流' : '点播资源' }}</dd></div><div><dt>发现来源</dt><dd>{{ sourceLabel(item.source) }}</dd></div><div><dt>MIME</dt><dd>{{ item.mime || '未知' }}</dd></div></dl>
                    <div class="url-box"><span>资源地址</span><code>{{ item.url }}</code><button class="text-button" @click="copyUrl(item.url)">复制</button></div>
                    <div v-if="item.extraction" class="url-box"><span>规则提取 · {{ item.extraction.ruleId }} · {{ item.extraction.observed ? '已观察到目标请求' : '尚未观察到目标请求' }}</span><code>{{ item.extraction.originalUrl }}</code><small>来源信息仅用于追溯；提取候选不自动发送到外部工具。</small></div>
                    <p v-if="previewError" class="inline-error detail-error">{{ previewError }}</p>
                  </div>
                </div></div>
              </Transition>
            </article>
            <div v-if="!loading && !visible.length" class="empty-state"><span>✦</span><h3>{{ resourceCandidates.length ? '没有符合筛选条件的资源' : '等待发现媒体资源' }}</h3><p>{{ resourceCandidates.length ? '调整筛选条件后再试。' : '保持来源网页打开并播放视频，流萤会自动收集资源。' }}</p></div>
          </div>
        </div>
      </Transition>
    </div>
  </section>
</template>
