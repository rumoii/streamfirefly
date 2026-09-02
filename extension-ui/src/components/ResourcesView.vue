<script setup lang="ts">
import Hls from "hls.js";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { MediaCandidate } from "../types";
import { filterCandidates, sortCandidates } from "../media";
import { formatBytes, formatDuration, sourceLabel, typeLabel } from "../format";
import { sendMessage } from "../api";

const props = defineProps<{ candidates: MediaCandidate[]; loading: boolean; sortMode: string }>();
const emit = defineEmits<{ download: [candidate: MediaCandidate]; parse: [candidate: MediaCandidate]; remove: [ids: string[]]; updateSort: [mode: string] }>();
const selectedIds = ref(new Set<string>());
const expandedId = ref("");
const collapsed = ref(false);
const pattern = ref("");
const type = ref("all");
const minMb = ref("");
const maxMb = ref("");
const previewing = ref(false);
const previewError = ref("");
const mediaElement = ref<HTMLVideoElement | HTMLAudioElement | null>(null);
const resourceScroll = ref<HTMLElement | null>(null);
let savedScrollTop = 0;
let hls: Hls | null = null;

const resourceCandidates = computed(() => props.candidates.filter(item => item.type !== "segment"));
const filtered = computed(() => filterCandidates(resourceCandidates.value, pattern.value, type.value, minMb.value, maxMb.value));
const visible = computed(() => sortCandidates(filtered.value.items, props.sortMode));
const expanded = computed(() => visible.value.find(item => item.id === expandedId.value) || null);
const segments = computed(() => props.candidates.filter(item => item.type === "segment"));

watch(visible, items => { if (expandedId.value && !items.some(item => item.id === expandedId.value)) expandedId.value = ""; });
watch(expanded, () => { void stopPreview(); });

function toggleSelection(id: string) {
  const next = new Set(selectedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  selectedIds.value = next;
}

function selectAll() { selectedIds.value = selectedIds.value.size === visible.value.length ? new Set() : new Set(visible.value.map(item => item.id)); }
function resourceName(item: MediaCandidate) { try { return item.title || item.pageTitle || new URL(item.url).pathname.split("/").pop() || "未命名资源"; } catch { return item.title || item.pageTitle || "未命名资源"; } }
function resourceMeta(item: MediaCandidate) { return [typeLabel(item.type), item.sizeKind === "manifest" ? "最终大小未知" : formatBytes(item.size), item.width && item.height ? `${item.width}×${item.height}` : null, item.duration ? formatDuration(item.duration) : null, sourceLabel(item.source)].filter(Boolean).join(" · "); }
function copyUrl(value: string) { void navigator.clipboard.writeText(value); }
function setMediaElement(value: unknown) { mediaElement.value = value instanceof HTMLMediaElement ? value as HTMLVideoElement | HTMLAudioElement : null; }

async function copySelected() {
  const items = resourceCandidates.value.filter(item => selectedIds.value.has(item.id));
  await navigator.clipboard.writeText(items.map(item => item.url).join("\n"));
}

async function toggleDetails(item: MediaCandidate) {
  if (expandedId.value === item.id) {
    await stopPreview();
    expandedId.value = "";
  } else {
    await stopPreview();
    expandedId.value = item.id;
  }
}

async function toggleList() {
  if (!collapsed.value) {
    savedScrollTop = resourceScroll.value?.scrollTop || 0;
    await stopPreview();
    collapsed.value = true;
    return;
  }
  collapsed.value = false;
  await nextTick();
  if (resourceScroll.value) resourceScroll.value.scrollTop = savedScrollTop;
}

async function startPreview() {
  if (!expanded.value) return;
  previewError.value = ""; previewing.value = true;
  await nextTick();
  const media = mediaElement.value;
  if (!media) return;
  await sendMessage({ type: "preview.headers.apply", payload: { url: expanded.value.url, headers: expanded.value.requestHeaders || {} } }).catch(() => {});
  if (expanded.value.type === "hls" && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, lowLatencyMode: false });
    hls.on(Hls.Events.ERROR, (_, data) => { if (data.fatal) previewError.value = "无法播放此 HLS 资源"; });
    hls.loadSource(expanded.value.url); hls.attachMedia(media);
  } else media.src = expanded.value.url;
  try { await media.play(); } catch (_) { previewError.value = "浏览器未能自动播放，请点击播放器中的播放按钮"; }
}

async function stopPreview() {
  hls?.destroy(); hls = null;
  if (mediaElement.value) { mediaElement.value.pause(); mediaElement.value.removeAttribute("src"); mediaElement.value.load(); }
  previewing.value = false; previewError.value = "";
  await sendMessage({ type: "preview.headers.clear" }).catch(() => {});
}

onBeforeUnmount(() => { void stopPreview(); });
</script>

<template>
  <section class="resource-layout expandable-resources">
    <div class="resource-list-panel panel">
      <div class="panel-title">
        <div><h2>发现资源</h2><p>{{ resourceCandidates.length }} 个媒体资源<span v-if="segments.length"> · {{ segments.length }} 个分片已收起</span></p></div>
        <div class="panel-title-actions"><span class="live-dot">实时</span><button class="collapse-button" type="button" :aria-expanded="!collapsed" @click="toggleList">{{ collapsed ? '展开资源' : '收起资源' }}<i></i></button></div>
      </div>
      <Transition name="panel-collapse">
        <div v-if="!collapsed" class="resource-panel-content">
          <div class="toolbar-grid">
            <input v-model="pattern" class="control search" type="search" placeholder="正则筛选名称、URL 或 MIME">
            <select v-model="type" class="control"><option value="all">全部类型</option><option value="video">视频与流媒体</option><option value="audio">音频</option><option value="image">图片</option></select>
            <select :value="sortMode" class="control" @change="$emit('updateSort', ($event.target as HTMLSelectElement).value)"><option value="detected">嗅探顺序</option><option value="size">文件大小</option><option value="duration">媒体时长</option><option value="type">类型分组</option></select>
            <div class="range-controls"><input v-model="minMb" class="control" type="number" min="0" placeholder="最小 MB"><span>—</span><input v-model="maxMb" class="control" type="number" min="0" placeholder="最大 MB"></div>
          </div>
          <div class="sort-hint">提示：视频资源通常体积较大，按文件大小排序可以更快找到视频。</div>
          <div v-if="filtered.error" class="inline-error">{{ filtered.error }}</div>
          <div v-if="visible.length" class="batch-bar"><label><input type="checkbox" :checked="selectedIds.size === visible.length" @change="selectAll"> 全选当前结果</label><span>已选 {{ selectedIds.size }} 项</span><div><button class="text-button" :disabled="!selectedIds.size" @click="copySelected">复制</button><button class="text-button danger" :disabled="!selectedIds.size" @click="$emit('remove', [...selectedIds])">移除</button></div></div>
          <div ref="resourceScroll" class="resource-scroll resource-cards">
            <template v-if="loading"><article v-for="index in 3" :key="index" class="resource-card skeleton-card"><i></i><div><b></b><span></span></div></article></template>
            <article v-for="item in visible" v-else :key="item.id" class="resource-card" :class="{ expanded: expandedId === item.id }">
              <div class="resource-summary">
                <label class="resource-select"><input type="checkbox" :checked="selectedIds.has(item.id)" :aria-label="`选择${resourceName(item)}`" @change="toggleSelection(item.id)"></label>
                <span class="resource-type">{{ typeLabel(item.type) }}</span>
                <span class="resource-identity"><strong>{{ resourceName(item) }}</strong><small>{{ resourceMeta(item) }}</small><em>{{ item.url }}</em></span>
                <span class="card-actions"><button v-if="item.type === 'hls' || item.type === 'dash'" class="button subtle" type="button" @click="$emit('parse', item)">解析</button><button class="button subtle" type="button" :aria-expanded="expandedId === item.id" @click="toggleDetails(item)">{{ expandedId === item.id ? '收起' : '详情' }}</button><button class="button primary" type="button" @click="$emit('download', item)">下载</button></span>
              </div>
              <Transition name="resource-detail">
                <div v-if="expandedId === item.id" class="expanded-detail"><div class="expanded-detail-inner">
                  <div class="expanded-preview" :class="{ image: item.type === 'image' }">
                    <img v-if="item.type === 'image'" :src="item.url" alt="资源预览">
                    <video v-else-if="['video','hls','dash'].includes(item.type)" :ref="setMediaElement" controls preload="metadata" :poster="item.poster || undefined"></video>
                    <audio v-else-if="item.type === 'audio'" :ref="setMediaElement" controls preload="metadata"></audio>
                    <div v-if="!previewing && item.type !== 'image'" class="preview-cover" :class="{ 'has-poster': item.poster }"><span>▶</span><strong>{{ typeLabel(item.type) }}预览</strong><button class="button primary" type="button" @click="startPreview">点击播放</button></div>
                    <button v-if="previewing" class="preview-close" type="button" @click="stopPreview">停止预览</button>
                  </div>
                  <div class="expanded-info">
                    <dl class="detail-grid"><div><dt>文件大小</dt><dd>{{ item.sizeKind === 'manifest' ? '最终大小未知' : formatBytes(item.size) }}</dd></div><div><dt>分辨率</dt><dd>{{ item.width && item.height ? `${item.width} × ${item.height}` : '未知' }}</dd></div><div><dt>媒体时长</dt><dd>{{ formatDuration(item.duration) }}</dd></div><div><dt>发现来源</dt><dd>{{ sourceLabel(item.source) }}</dd></div><div><dt>MIME</dt><dd>{{ item.mime || '未知' }}</dd></div><div><dt>发现时间</dt><dd>{{ item.detectedAt ? new Date(item.detectedAt).toLocaleTimeString() : '未知' }}</dd></div></dl>
                    <div class="url-box"><span>资源地址</span><code>{{ item.url }}</code><button class="text-button" @click="copyUrl(item.url)">复制</button></div>
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
