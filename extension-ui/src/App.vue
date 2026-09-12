<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { surfaceFromUrl } from "./api";
import { useAppStore, humanError } from "./store";
import type { MediaCandidate } from "./types";
import AppHeader from "./components/AppHeader.vue";
import ResourcesView from "./components/ResourcesView.vue";
import BatchDownloadDialog from "./components/BatchDownloadDialog.vue";
import ConnectionBanner from "./components/ConnectionBanner.vue";
import SettingsView from "./components/SettingsView.vue";
import DispatchView from "./features/configuration/DispatchView.vue";
import CaptureView from "./features/configuration/CaptureView.vue";
import ResourceTools from "./features/configuration/ResourceTools.vue";
import { openCapture, openDispatch } from "./features/configuration/client";
import DownloadDialog from "./components/DownloadDialog.vue";
import TaskOverview from "./components/TaskOverview.vue";

const store = useAppStore();
const surface = surfaceFromUrl();
const isOptions = computed(() => surface === "options");
const isDispatch = new URLSearchParams(location.search).has("dispatch");
const isCapture = new URLSearchParams(location.search).has("captureTab");
const downloadCandidate = ref<MediaCandidate | null>(null);
const batchCandidates = ref<MediaCandidate[] | null>(null);
watch(() => store.context?.sourceContextId, (next, previous) => { if (previous && next !== previous) downloadCandidate.value = null; });
const toast = ref("");
let toastTimer = 0;

function showToast(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.value = "", 3500); }
async function guard(action: () => Promise<any>, success?: string) { try { await action(); if (success) showToast(success); } catch (reason: any) { showToast(humanError(reason?.message)); } }
async function resetSettings() { const next = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, candidateSort: store.settings.candidateSort }; await guard(() => store.saveSettings(next), "已恢复默认设置"); }
function openParser(candidate: MediaCandidate) { void guard(() => store.openWorkspace(["hls", "dash"].includes(candidate.type) ? "parser" : "resources", candidate.id)); }

function sendExternal(candidates: MediaCandidate[]) { const context = store.context; if (context) void guard(() => openDispatch(context.sourceTabId, context.sourceContextId, candidates.map(candidate => candidate.id))); }
function captureBlob(candidate: MediaCandidate) { const context = store.context; if (context) void guard(() => openCapture(context.sourceTabId, context.sourceContextId, candidate.url)); }
function openDownload(candidate: MediaCandidate) { if (candidate.type === "dash") openParser(candidate); else downloadCandidate.value = candidate; }

onMounted(() => store.initialize(surface));
onBeforeUnmount(() => clearTimeout(toastTimer));
</script>

<template>
  <div v-if="isOptions" class="app-shell options-shell">
    <AppHeader :context="null" :loading="store.loading" @refresh="store.refresh" @toggle-sniffing="store.toggleSniffing" />
    <main class="app-content"><DispatchView v-if="isDispatch" /><CaptureView v-else-if="isCapture" /><SettingsView v-else :settings="store.settings" @save="settings => guard(() => store.saveSettings(settings), '设置已保存')" @reset="resetSettings" /></main>
  </div>
  <div v-else class="app-shell sidebar-shell">
    <AppHeader :context="store.context" :loading="store.loading" compact @refresh="store.refresh" @toggle-sniffing="guard(store.toggleSniffing)" />
    <main class="sidebar-content">
      <ConnectionBanner :state="store.connection" :error="store.connectionError" @retry="store.refresh" />
      <div v-if="store.error" class="status-banner error">{{ store.error }}</div>
      <div v-else-if="store.context && !store.context.supported" class="restricted-state">
        <span>⌁</span><h2>当前页面不支持嗅探</h2><p>浏览器内部页面、扩展页面和本地受限页面不能读取媒体请求，也不能展开工作区。</p>
      </div>
      <template v-else>
        <div class="sidebar-source-summary"><strong>{{ store.candidates.filter(item => item.type !== 'segment').length }}</strong><span>个媒体资源</span><i></i><strong>{{ store.activeTasks.length }}</strong><span>个活动任务</span></div>
        <ResourcesView :connected="store.connection === 'ready'" @batch-download="batchCandidates = $event" :candidates="store.candidates" :loading="store.loading" :view-state="store.resourceViewState" compact @download="openDownload" @capture-blob="captureBlob" @parse="openParser" @remove="guard(() => store.removeCandidates($event), '已从列表移除资源')" @update-view-state="patch => guard(() => store.patchResourceView(patch))" @metadata="(candidate, metadata) => guard(() => store.updateCandidateMetadata(candidate, metadata))" :external-enabled="Boolean(store.context?.supported)" @external-download="sendExternal"><template #header-tools><ResourceTools :context="store.context" /></template></ResourcesView>
        <TaskOverview :source-tasks="store.sourceTasks" :active-tasks="store.activeTasks" />
      </template>
    </main>
    <footer class="sidebar-actions">
      <button class="button primary" type="button" :disabled="!store.context?.supported" @click="guard(() => store.openWorkspace('resources'))">展开工作区</button>
      <button class="button subtle" type="button" :disabled="!store.context?.supported" @click="guard(() => store.openWorkspace('settings'))">设置</button>
    </footer>
    <BatchDownloadDialog :candidates="batchCandidates" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :connected="store.connection === 'ready'" @close="batchCandidates = null" @inspect="candidate => { batchCandidates = null; openParser(candidate); }" />
    <DownloadDialog :connected="store.connection === 'ready'" :candidate="downloadCandidate" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :capabilities="store.capabilities" @close="downloadCandidate = null" @created="message => { showToast(message); downloadCandidate = null; }" />
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
  </div>
</template>
