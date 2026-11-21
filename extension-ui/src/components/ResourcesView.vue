<script setup lang="ts">
import { copyResources } from "../features/configuration/copy";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { MediaCandidate, PageFocus, PagePick, ResourceViewState } from "../types";
import { betterAlternative, filterCandidates, focusedCandidateIds, isBlobCandidate, pickedCandidateIds, sortCandidates } from "../media";
import { formatBytes, formatDuration, sourceLabel, typeLabel } from "../format";
import { extensionApi } from "../api";
import SfIcon from "../ui/SfIcon.vue";
import SfMenu, { type MenuItem } from "../ui/SfMenu.vue";
import SfPopover from "../ui/SfPopover.vue";
import SfSelect from "../ui/SfSelect.vue";
import type { IconName } from "../ui/icons";
import { createMediaPreview, type PreviewState } from "../media-preview";

const props = defineProps<{ candidates: MediaCandidate[]; focus?: PageFocus | null; pick?: PagePick | null; picking?: boolean; pickAvailable?: boolean; loading: boolean; viewState: ResourceViewState; compact?: boolean; coverOnly?: boolean; suspended?: boolean; sourceContextId?: string; connected?: boolean; externalEnabled?: boolean }>();
const emit = defineEmits<{
  download: [candidate: MediaCandidate];
  externalDownload: [candidates: MediaCandidate[]];
  batchDownload: [candidates: MediaCandidate[]];
  captureBlob: [candidate: MediaCandidate];
  parse: [candidate: MediaCandidate];
  inspect: [candidate: MediaCandidate];
  remove: [ids: string[]];
  updateViewState: [patch: Partial<Omit<ResourceViewState, "revision">>];
  metadata: [candidate: MediaCandidate, metadata: Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">>];
  pickStart: [];
  pickCancel: [];
  pickClear: [];
}>();
const typeOptions: { value: ResourceViewState["type"]; label: string }[] = [{ value: "all", label: "全部类型" }, { value: "video", label: "视频与流媒体" }, { value: "audio", label: "音频" }, { value: "image", label: "图片" }];
const sortOptions: { value: ResourceViewState["sortMode"]; label: string }[] = [{ value: "detected", label: "嗅探顺序" }, { value: "size", label: "文件大小" }, { value: "duration", label: "媒体时长" }];
const typeIcons: Record<string, IconName> = { video: "movie", audio: "music", image: "photo", hls: "playlist", dash: "playlist" };
const advancedFilterCount = computed(() => [props.viewState.minMb, props.viewState.maxMb, props.viewState.minDuration, props.viewState.maxDuration].filter(value => value !== "" && value != null).length);
const selectedIds = ref(new Set<string>());
const failedImages = ref(new Set<string>());
const previewState = ref<PreviewState>("idle");
const previewError = ref("");
const mediaElement = ref<HTMLVideoElement | HTMLAudioElement | null>(null);

const resourceCandidates = computed(() => props.candidates.filter(item => item.type !== "segment"));
const filtered = computed(() => filterCandidates(resourceCandidates.value, props.viewState.pattern, props.viewState.type, props.viewState.minMb, props.viewState.maxMb, props.viewState.minDuration, props.viewState.maxDuration));
const focused = computed(() => focusedCandidateIds(resourceCandidates.value, props.focus));
const picked = computed(() => pickedCandidateIds(resourceCandidates.value, props.pick));
const visible = computed(() => sortCandidates(filtered.value.items, props.viewState.sortMode, focused.value, picked.value));
const pickedHidden = computed(() => picked.value.size > 0 && !visible.value.some(item => picked.value.has(item.id)));
const pickSummary = computed(() => {
  const pick = props.pick;
  if (!pick) return "";
  return [{ video: "视频", audio: "音频", image: "图片" }[pick.kind], pick.width && pick.height ? `${pick.width}×${pick.height}` : "", pick.duration ? formatDuration(pick.duration) : ""].filter(Boolean).join(" · ");
});
const pickMessage = computed(() => {
  if (!props.pick) return "";
  if (!picked.value.size) return props.pick.kind === "image" ? "没找到这张图片的地址。" : "没找到对应的可下载资源。让它播放一会儿后重新拾取，或对它使用缓存捕捉。";
  return pickedHidden.value ? `${picked.value.size} 个相关资源被当前筛选隐藏。` : `${picked.value.size} 个相关资源已置顶`;
});
// A long list suggests picking once; closing the hint or picking at all retires it for good.
const pickHintDismissed = ref<boolean | null>(null);
void (async () => {
  let dismissed = true;
  try { dismissed = (await extensionApi()?.storage?.local?.get(["pickHintDismissed"]))?.pickHintDismissed === true; } catch { /* Keep the hint hidden. */ }
  if (pickHintDismissed.value === null) pickHintDismissed.value = dismissed;
})();
const showPickHint = computed(() => pickHintDismissed.value === false && !props.pick && !props.picking && props.pickAvailable !== false && resourceCandidates.value.length > 10);
function dismissPickHint() {
  if (pickHintDismissed.value === true) return;
  pickHintDismissed.value = true;
  try { void extensionApi()?.storage?.local?.set({ pickHintDismissed: true })?.catch?.(() => {}); } catch { /* Hidden for this view only. */ }
}
function startPick() { dismissPickHint(); emit("pickStart"); }
function clearFilters() { emit("updateViewState", { pattern: "", type: "all", minMb: "", maxMb: "", minDuration: "", maxDuration: "" }); }
const expanded = computed(() => visible.value.find(item => item.id === props.viewState.expandedId) || null);
const captureExplanation = "缓存捕捉也能把视频保存到本地：有些网站不提供可直接下载的地址（显示为 Blob），流萤会在视频播放时录下加载的视频数据，播完自动保存成文件。";
const captureCount = computed(() => visible.value.filter(isBlobCandidate).length);
const showCaptureHint = computed(() => captureCount.value > 0 && visible.value.length > captureCount.value);
const resourceScroll = ref<HTMLElement | null>(null);
function scrollToCapture() {
  const first = visible.value.find(isBlobCandidate);
  const row = first ? [...(resourceScroll.value?.querySelectorAll<HTMLElement>("[data-candidate-id]") || [])].find(element => element.dataset.candidateId === first.id) : undefined;
  row?.scrollIntoView({ block: "center", behavior: "smooth" });
}
const alternative = computed(() => expanded.value ? betterAlternative(expanded.value, visible.value) : null);
const alternativeText = computed(() => {
  const found = alternative.value;
  if (!found) return "";
  const { candidate } = found;
  if (found.reason === "resolution") return `疑似发现分辨率更高的同一视频（${candidate.width} × ${candidate.height}）`;
  return `发现可直接下载的同一视频（${typeLabel(candidate.type)}），通常画质更完整，下载也更快`;
});
const segments = computed(() => props.candidates.filter(item => item.type === "segment"));
const selectedCandidates = computed(() => visible.value.filter(item => selectedIds.value.has(item.id)));
const selectedHasBlob = computed(() => selectedCandidates.value.some(isBlobCandidate));

watch(visible, items => {
  selectedIds.value = new Set([...selectedIds.value].filter(id => items.some(item => item.id === id)));
  if (props.viewState.expandedId && !items.some(item => item.id === props.viewState.expandedId)) emit("updateViewState", { expandedId: "" });
});


function coverUrl(item: MediaCandidate) {
  const url = item.type === "image" ? item.url : item.poster || "";
  return url && !failedImages.value.has(url) ? url : "";
}
function markImageFailed(url: string) { failedImages.value = new Set(failedImages.value).add(url); }

function updateViewState<K extends keyof Omit<ResourceViewState, "revision">>(key: K, value: ResourceViewState[K]) {
  emit("updateViewState", { [key]: value } as Partial<Omit<ResourceViewState, "revision">>);
}

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedIds.value = next;
}

function selectAll() { selectedIds.value = selectedIds.value.size === visible.value.length ? new Set() : new Set(visible.value.map(item => item.id)); }
function clearSelection() { selectedIds.value = new Set(); }
function resourceName(item: MediaCandidate) { try { return item.title || item.pageTitle || new URL(item.url).pathname.split("/").pop() || "未命名资源"; } catch { return item.title || item.pageTitle || "未命名资源"; } }
function sizeText(item: MediaCandidate) { return item.sizeKind === "manifest" ? "最终大小未知" : formatBytes(item.size); }
function resourceMeta(item: MediaCandidate) { return [sizeText(item), item.width && item.height ? `${item.width}×${item.height}` : null, item.duration ? formatDuration(item.duration) : null, sourceLabel(item.source)].filter(Boolean).join(" · "); }
function isStream(item: MediaCandidate) { return item.type === "hls" || item.type === "dash"; }
function primaryLabel(item: MediaCandidate) { return isBlobCandidate(item) ? "缓存捕捉" : props.compact && item.type === "hls" ? "快速下载" : "下载"; }
function runPrimary(item: MediaCandidate) { if (isBlobCandidate(item)) emit("captureBlob", item); else emit("download", item); }
function rowMenu(item: MediaCandidate): MenuItem[] {
  return [
    { key: "details", label: props.viewState.expandedId === item.id ? "关闭详情" : "查看详情", icon: "info-circle" },
    ...(isStream(item) ? [{ key: "parse", label: "详细解析", icon: "adjustments-horizontal" as IconName }] : []),
    ...(props.externalEnabled && !isBlobCandidate(item) ? [{ key: "external", label: "发送到外部工具…", icon: "external-link" as IconName }] : []),
    { key: "copy", label: "复制地址", icon: "copy" },
    { key: "remove", label: "从列表移除", icon: "trash", danger: true }
  ];
}
function onRowMenu(item: MediaCandidate, key: string) {
  if (key === "details") toggleDetails(item);
  else if (key === "parse") emit("parse", item);
  else if (key === "external") emit("externalDownload", [item]);
  else if (key === "copy") copyUrl(item.url);
  else if (key === "remove") emit("remove", [item.id]);
}
function copyUrl(value: string) { const candidate = props.candidates.find(item => item.url === value); if (candidate) void copyResources([candidate]).catch(error => { previewError.value = error.message; }); }
function setMediaElement(value: unknown) { mediaElement.value = typeof HTMLMediaElement !== "undefined" && value instanceof HTMLMediaElement ? value as HTMLVideoElement | HTMLAudioElement : null; }

async function copySelected() {
  const items = resourceCandidates.value.filter(item => selectedIds.value.has(item.id));
  try { await copyResources(items); } catch (error) { previewError.value = error instanceof Error ? error.message : "复制失败"; }
}

function toggleDetails(item: MediaCandidate) {
  updateViewState("expandedId", props.viewState.expandedId === item.id ? "" : item.id);
}

function closeDetails() { updateViewState("expandedId", ""); }

let detailOwner: { candidate: MediaCandidate; contextId?: string } | null = null;
const detailPreview = createMediaPreview({
  state: state => { previewState.value = state; },
  error: message => { previewError.value = message; },
  metadata: metadata => {
    if (detailOwner && detailOwner.contextId === props.sourceContextId && expanded.value?.id === detailOwner.candidate.id) emit("metadata", detailOwner.candidate, metadata);
  }
});
async function preparePreview(item: MediaCandidate) {
  const media = mediaElement.value;
  detailOwner = { candidate: item, contextId: props.sourceContextId };
  if (media) {
    try { await detailPreview.prepare(item, media); }
    catch { previewState.value = "failed"; previewError.value = "无法准备此资源的预览，请检查来源页面是否仍可播放。"; }
  }
}
async function startPreview() {
  const item = expanded.value;
  if (!item) return;
  if (["idle", "failed"].includes(previewState.value)) await preparePreview(item);
  await detailPreview.play();
}
async function disposePreview() {
  detailOwner = null;
  await detailPreview.dispose();
  previewState.value = "idle"; previewError.value = "";
}

let disposed = false;
let detailSequence = 0;
watch([() => props.viewState.expandedId, () => props.coverOnly, () => props.suspended, () => props.sourceContextId], async () => {
  const sequence = ++detailSequence;
  await disposePreview();
  if (disposed || sequence !== detailSequence) return;
  if (!props.viewState.expandedId || props.coverOnly || props.suspended) return;
  await nextTick();
  if (disposed || sequence !== detailSequence || props.coverOnly || props.suspended) return;
  const item = expanded.value;
  if (item && item.type !== "image" && !isBlobCandidate(item)) await preparePreview(item);
}, { immediate: true });
onBeforeUnmount(() => {
  disposed = true; detailSequence++;
  void detailPreview.dispose();
});

</script>

<template>
  <section class="resources" :class="{ compact, 'has-detail': Boolean(expanded) }">
    <div v-if="!selectedIds.size" class="resource-toolbar">
      <label class="search-field"><SfIcon name="search" /><input :value="viewState.pattern" type="search" aria-label="筛选资源" placeholder="筛选名称、URL 或 MIME（支持正则）" @input="updateViewState('pattern', ($event.target as HTMLInputElement).value)"></label>
      <div v-if="!compact" class="segmented type-filter" role="group" aria-label="资源类型"><button v-for="option in typeOptions" :key="option.value" type="button" :data-value="option.value" :class="{ active: viewState.type === option.value }" :aria-pressed="viewState.type === option.value" @click="updateViewState('type', option.value)">{{ option.label }}</button></div>
      <SfSelect v-else :model-value="viewState.type" :options="typeOptions" label="资源类型" @update:model-value="updateViewState('type', $event)" />
      <SfSelect v-if="!compact" :model-value="viewState.sortMode" :options="sortOptions" label="排序方式" @update:model-value="updateViewState('sortMode', $event)" />
      <SfPopover label="更多筛选" icon="adjustments-horizontal" :text="compact ? undefined : '筛选'" :badge="advancedFilterCount">
        <div class="filter-form">
          <label v-if="compact" class="field"><span>排序方式</span><SfSelect :model-value="viewState.sortMode" :options="sortOptions" label="排序方式" @update:model-value="updateViewState('sortMode', $event)" /></label>
          <fieldset class="field"><legend>文件大小（MB）</legend><div class="range-controls"><input :value="viewState.minMb" class="control" type="number" min="0" aria-label="最小 MB" placeholder="最小" @input="updateViewState('minMb', ($event.target as HTMLInputElement).value)"><span>—</span><input :value="viewState.maxMb" class="control" type="number" min="0" aria-label="最大 MB" placeholder="最大" @input="updateViewState('maxMb', ($event.target as HTMLInputElement).value)"></div></fieldset>
          <fieldset class="field"><legend>媒体时长（秒）</legend><div class="range-controls"><input :value="viewState.minDuration" class="control" type="number" min="0" aria-label="最短时长（秒）" placeholder="最短" @input="updateViewState('minDuration', ($event.target as HTMLInputElement).value)"><span>—</span><input :value="viewState.maxDuration" class="control" type="number" min="0" aria-label="最长时长（秒）" placeholder="最长" @input="updateViewState('maxDuration', ($event.target as HTMLInputElement).value)"></div></fieldset>
          <button class="button ghost" type="button" :disabled="!advancedFilterCount" @click="$emit('updateViewState', { minMb: '', maxMb: '', minDuration: '', maxDuration: '' })">清除大小与时长条件</button>
        </div>
      </SfPopover>
      <button class="button" :class="{ active: picking }" type="button" :aria-pressed="Boolean(picking)" :disabled="!picking && pickAvailable === false" :title="picking ? '取消拾取（Esc）' : pickAvailable === false ? '继续嗅探后才能拾取' : '在页面上点选一个视频、音频或图片，把它和它的各个分辨率置顶'" @click="picking ? $emit('pickCancel') : startPick()"><SfIcon name="focus-2" /><span>{{ picking ? '拾取中…' : '拾取' }}</span></button>
      <slot name="header-tools" />
    </div>
    <div v-else class="resource-toolbar selection-bar" role="toolbar" aria-label="已选资源操作">
      <strong>已选 {{ selectedIds.size }} 项</strong><span v-if="selectedHasBlob" class="selection-hint">Blob 需单独缓存捕捉</span>
      <div class="selection-actions">
        <button class="button primary" :disabled="selectedHasBlob || connected === false" :title="selectedHasBlob ? 'Blob 临时媒体需单独缓存捕捉' : ''" @click="$emit('batchDownload', selectedCandidates)"><SfIcon name="download" /><span>批量下载</span></button>
        <button class="button" @click="copySelected"><SfIcon name="copy" /><span>复制</span></button>
        <button v-if="externalEnabled" class="button" :disabled="selectedHasBlob" :title="selectedHasBlob ? 'Blob 临时媒体不能发送到外部工具' : ''" @click="$emit('externalDownload', selectedCandidates)"><SfIcon name="external-link" /><span>发送到外部工具…</span></button>
        <button class="button danger-ghost" @click="$emit('remove', [...selectedIds])"><SfIcon name="trash" /><span>移除</span></button>
        <button class="icon-button" aria-label="取消选择" title="取消选择" @click="clearSelection"><SfIcon name="x" /></button>
      </div>
    </div>
    <div v-if="pick && !loading" class="pick-status" :class="{ warn: !picked.size || pickedHidden }" role="status">
      <SfIcon :name="picked.size && !pickedHidden ? 'focus-2' : 'alert-triangle'" />
      <span class="pick-text">已拾取 <strong>{{ pickSummary }}</strong><small>{{ pickMessage }}</small></span>
      <button v-if="pickedHidden" class="button sm" type="button" @click="clearFilters">清除筛选</button>
      <button class="button sm ghost" type="button" :disabled="picking || pickAvailable === false" @click="startPick">重新拾取</button>
      <button class="icon-button" type="button" aria-label="取消拾取" title="取消拾取" @click="$emit('pickClear')"><SfIcon name="x" /></button>
    </div>
    <div v-if="!loading && showPickHint" class="capture-hint deep-search-hint pick-hint">
      <button type="button" class="deep-search-hint-open" @click="startPick"><SfIcon name="focus-2" /><span>资源太多？点「拾取」，直接在页面上点选想要的视频，它和它的各个分辨率会排到最前面。</span></button>
      <button type="button" class="deep-search-hint-close" aria-label="关闭提示" title="关闭提示" @click="dismissPickHint"><SfIcon name="x" /></button>
    </div>
    <button v-if="!loading && showCaptureHint" type="button" class="capture-hint" @click="scrollToCapture"><SfIcon name="info-circle" /><span>找不到能下载的视频？列表底部有 {{ captureCount }} 个可以<span class="term-hint" :title="captureExplanation">「缓存捕捉」</span>的视频</span><SfIcon name="chevron-down" /></button>
    <slot v-if="!loading" name="hints" />
    <div v-if="filtered.error" class="inline-error">{{ filtered.error }}</div>
    <div class="resource-body">
      <div class="resource-list">
        <div class="resource-head">
          <label class="row-check"><input type="checkbox" class="checkbox" aria-label="全选当前结果" :checked="visible.length > 0 && selectedIds.size === visible.length" :indeterminate="selectedIds.size > 0 && selectedIds.size < visible.length" :disabled="!visible.length" @change="selectAll"></label>
          <span class="head-name">{{ resourceCandidates.length }} 个资源<template v-if="visible.length !== resourceCandidates.length"> · 显示 {{ visible.length }} 个</template><template v-if="segments.length"> · {{ segments.length }} 个分片已隐藏</template></span>
          <span class="cell-resolution">分辨率</span><span class="cell-duration">时长</span><span class="cell-size">大小</span><span class="cell-actions"></span>
        </div>
        <div ref="resourceScroll" class="resource-scroll">
          <template v-if="loading"><div v-for="index in 4" :key="index" class="resource-row skeleton-row"><i></i><b></b></div></template>
          <article v-for="item in visible" v-else :key="item.id" :data-candidate-id="item.id" class="resource-row" :class="{ selected: selectedIds.has(item.id), active: viewState.expandedId === item.id, picked: picked.has(item.id) }">
            <label class="row-check"><input type="checkbox" class="checkbox" :checked="selectedIds.has(item.id)" :aria-label="`选择${resourceName(item)}`" @change="toggleSelection(item.id)"></label>
            <span class="type-tile" :class="{ thumb: coverUrl(item) }" :data-type="item.type" :title="typeLabel(item.type)"><img v-if="coverUrl(item)" :src="coverUrl(item)" alt="" loading="lazy" decoding="async" @error="markImageFailed(coverUrl(item))"><SfIcon v-else :name="typeIcons[item.type] || 'file'" /></span>
            <button class="row-main" type="button" :aria-expanded="viewState.expandedId === item.id" :title="resourceName(item)" @click="toggleDetails(item)">
              <span class="row-title"><strong>{{ resourceName(item) }}</strong><em v-if="isStream(item)" class="chip">{{ typeLabel(item.type) }}</em><em v-if="item.live" class="chip live">直播</em><em v-if="picked.has(item.id)" class="chip picked">已拾取</em><em v-if="item.userPicked && picked.has(item.id)" class="chip added" title="「识别图片」关闭时，你拾取的图片仍会加入列表">拾取加入</em><em v-if="focused.has(item.id)" class="chip current">当前视频</em></span>
              <span class="row-meta">{{ resourceMeta(item) }}</span>
            </button>
            <span class="cell-resolution">{{ item.width && item.height ? `${item.width}×${item.height}` : '—' }}</span><span class="cell-duration">{{ item.duration ? formatDuration(item.duration) : '—' }}</span><span class="cell-size">{{ sizeText(item) }}</span>
            <span class="cell-actions">
              <button class="button sm" :class="isBlobCandidate(item) ? '' : 'primary-soft'" type="button" :disabled="connected === false" :aria-label="`${primaryLabel(item)}：${resourceName(item)}`" :title="isBlobCandidate(item) ? captureExplanation : undefined" @click="runPrimary(item)"><SfIcon :name="isBlobCandidate(item) ? 'capture' : 'download'" /><span>{{ primaryLabel(item) }}</span></button>
              <SfMenu :items="rowMenu(item)" :label="`更多操作：${resourceName(item)}`" @select="onRowMenu(item, $event)" />
            </span>
          </article>
          <div v-if="!loading && !visible.length" class="empty-state"><span><SfIcon :name="resourceCandidates.length ? 'search' : 'radar-2'" :size="22" /></span><h3>{{ resourceCandidates.length ? '没有符合筛选条件的资源' : '等待发现媒体资源' }}</h3><p>{{ resourceCandidates.length ? '调整筛选条件后再试。' : '播放视频后流萤会自动收集资源；仍未出现时，可刷新网页后重新打开流萤，或在设置中改为始终嗅探。' }}</p></div>
        </div>
      </div>
      <aside v-if="expanded" class="resource-detail-pane" :aria-label="`资源详情：${resourceName(expanded)}`">
        <header>
          <button v-if="compact" class="icon-button" type="button" aria-label="返回资源列表" title="返回资源列表" @click="closeDetails"><SfIcon name="chevron-left" /></button>
          <strong :title="resourceName(expanded)">{{ resourceName(expanded) }}</strong>
          <button v-if="!compact" class="icon-button" type="button" aria-label="关闭详情" title="关闭详情" @click="closeDetails"><SfIcon name="x" /></button>
        </header>
        <template v-for="item in [expanded]" :key="item.id">
          <div class="detail-body">
            <div v-if="coverOnly" class="expanded-preview" :class="{ image: item.type === 'image' }">
              <img v-if="coverUrl(item)" :src="coverUrl(item)" :alt="item.type === 'image' ? '资源预览' : '媒体封面'" @error="markImageFailed(coverUrl(item))">
              <div v-else class="cover-placeholder"><SfIcon :name="typeIcons[item.type] || 'file'" :size="28" /><span>{{ isBlobCandidate(item) ? 'Blob 页面临时媒体，请使用缓存捕捉' : '暂无封面，可在工作区预览' }}</span></div>
            </div>
            <div v-else-if="!suspended" class="expanded-preview" :class="{ image: item.type === 'image' }">
              <img v-if="item.type === 'image'" :src="item.url" alt="资源预览">
              <img v-else-if="isBlobCandidate(item) && item.poster" :src="item.poster" alt="媒体封面">
              <div v-else-if="isBlobCandidate(item)" class="blob-preview-status"><strong>Blob 页面临时媒体</strong><span>无法脱离来源页面直接预览，请使用缓存捕捉。</span></div>
              <video v-else-if="['video','hls','dash'].includes(item.type)" :ref="setMediaElement" :controls="previewState === 'playing' || previewState === 'failed'" preload="auto" playsinline :poster="item.poster || undefined"></video>
              <audio v-else-if="item.type === 'audio'" :ref="setMediaElement" controls preload="auto"></audio>
              <div v-if="previewState === 'preparing' && item.type !== 'image' && !isBlobCandidate(item)" class="preview-status" :class="{ 'has-poster': item.poster }"><i></i><strong>正在准备封面与媒体信息</strong><span>只加载预览所需的少量数据</span></div>
              <button v-if="(previewState === 'ready' || previewState === 'preparing' && item.poster) && item.type !== 'image' && !isBlobCandidate(item)" class="preview-play" type="button" @click="startPreview"><span><SfIcon name="player-play" :size="20" /></span><strong>播放预览</strong></button>
              <div v-if="isBlobCandidate(item) && item.poster" class="blob-poster-note">Blob 页面临时媒体 · 请使用缓存捕捉</div>
            </div>
            <div v-if="alternative" class="detail-alternative" role="note"><SfIcon name="sparkles" /><span>{{ alternativeText }}</span><button class="button sm primary-soft" type="button" @click="updateViewState('expandedId', alternative.candidate.id)">查看</button></div>
            <div class="detail-actions">
              <button class="button primary" type="button" :disabled="connected === false" :title="isBlobCandidate(item) ? captureExplanation : undefined" @click="runPrimary(item)"><SfIcon :name="isBlobCandidate(item) ? 'capture' : 'download'" /><span>{{ primaryLabel(item) }}</span></button>
              <button v-if="isStream(item)" class="button" type="button" @click="$emit('parse', item)"><SfIcon name="adjustments-horizontal" /><span>详细解析</span></button>
              <button v-if="coverOnly && item.type !== 'image' && !isBlobCandidate(item)" class="button" type="button" @click="$emit('inspect', item)"><SfIcon name="eye" /><span>在工作区预览</span></button>
            </div>
            <dl class="detail-grid"><div><dt>类型</dt><dd>{{ typeLabel(item.type) }}{{ item.live ? ' · 直播流' : '' }}</dd></div><div><dt>文件大小</dt><dd>{{ sizeText(item) }}</dd></div><div><dt>分辨率</dt><dd>{{ item.width && item.height ? `${item.width} × ${item.height}` : '未知' }}</dd></div><div><dt>媒体时长</dt><dd>{{ formatDuration(item.duration) }}</dd></div><div><dt>发现来源</dt><dd>{{ sourceLabel(item.source) }}</dd></div><div><dt>MIME</dt><dd>{{ item.mime || '未知' }}</dd></div></dl>
            <div class="url-box"><span>资源地址</span><code>{{ item.url }}</code><button class="icon-button" type="button" aria-label="复制资源地址" title="复制资源地址" @click="copyUrl(item.url)"><SfIcon name="copy" /></button></div>
            <div v-if="item.extraction" class="url-box"><span>规则提取 · {{ item.extraction.ruleId }} · {{ item.extraction.observed ? '已观察到目标请求' : '尚未观察到目标请求' }}</span><code>{{ item.extraction.originalUrl }}</code><small>来源信息仅用于追溯；提取候选不自动发送到外部工具。</small></div>
            <p v-if="previewError" class="inline-error">{{ previewError }}</p>
          </div>
        </template>
      </aside>
    </div>
  </section>
</template>
