<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAppStore, humanError } from "./store";
import type { DownloadTask, MediaCandidate } from "./types";
import FloatingShell from "./components/FloatingShell.vue";
import type { DisplayMode } from "./floating-layout";
import { sendMessage } from "./api";
import ResourcesView from "./components/ResourcesView.vue";
import BatchDownloadDialog from "./components/BatchDownloadDialog.vue";
import ConnectionBanner from "./components/ConnectionBanner.vue";
import DownloadsView from "./components/DownloadsView.vue";
import SettingsView from "./components/SettingsView.vue";
import ResourceTools from "./features/configuration/ResourceTools.vue";
import { openCapture, openDispatch } from "./features/configuration/client";
import DownloadDialog from "./components/DownloadDialog.vue";
import DashParserView from "./components/DashParserView.vue";
import HlsParserView from "./components/HlsParserView.vue";

const store = useAppStore();
const floating = ref<InstanceType<typeof FloatingShell> | null>(null);
const settingsView = ref<InstanceType<typeof SettingsView> | null>(null);
const displayMode = ref<DisplayMode>("panel");
const isPanel = computed(() => displayMode.value === "panel");
const suspended = computed(() => displayMode.value === "collapsed");
const route = ref("resources");
const parserCandidate = ref<MediaCandidate | null>(null);
const downloadCandidate = ref<MediaCandidate | null>(null);
const batchCandidates = ref<MediaCandidate[] | null>(null);
const pendingCandidateId = ref("");
const toast = ref("");
let toastTimer = 0;
let ready = false;
let disposed = false;
let pendingNavigation: { view?: string; candidateId?: string; displayMode?: string; attemptId?: string } | null = null;
const tab = computed(() => parserCandidate.value ? "parser" : route.value);
watch(() => store.context?.sourceContextId, (next, previous) => { if (previous && next !== previous) { downloadCandidate.value = null; parserCandidate.value = null; } });

function showToast(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.value = "", 3500); }
function beforeLeave() { return !settingsView.value?.hasUnsavedChanges || window.confirm("设置尚未保存，确定放弃修改吗？"); }
function onModeChange(mode: DisplayMode) { displayMode.value = mode; if (mode === "panel") { parserCandidate.value = null; route.value = "resources"; } }
function navigate(value: string) { if (value !== tab.value && !beforeLeave()) return; parserCandidate.value = null; route.value = value; if (value !== "resources" && isPanel.value) floating.value?.setMode("workspace"); }
async function guard(action: () => Promise<any>, success?: string) { try { await action(); if (success) showToast(success); } catch (reason: any) { showToast(humanError(reason?.message)); } }
async function resetSettings() { const next = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, sniffMode: "on_open" as const, candidateSort: store.settings.candidateSort, proxyMode: "system" as const, proxyUrl: "" }; await guard(() => store.saveSettings(next), "已恢复默认设置"); }
function openParser(candidate: MediaCandidate) { if (["hls", "dash"].includes(candidate.type) && beforeLeave()) { floating.value?.setMode("workspace"); parserCandidate.value = candidate; } }
function openDetails(candidate: MediaCandidate) { floating.value?.setMode("workspace"); void guard(() => store.patchResourceView({ expandedId: candidate.id })); }
function sendExternal(candidates: MediaCandidate[]) { const context = store.context; if (context) void guard(() => openDispatch(context.sourceTabId, context.sourceContextId, candidates.map(candidate => candidate.id))); }
function captureBlob(candidate: MediaCandidate) { const context = store.context; if (context) void guard(() => openCapture(context.sourceTabId, context.sourceContextId, candidate.url)); }
function openDownload(candidate: MediaCandidate) { if (candidate.type === "dash") openParser(candidate); else downloadCandidate.value = candidate; }
function handleDelete(task: DownloadTask, deleteFile: boolean) { void guard(() => store.deleteTask(task, deleteFile), deleteFile ? "已删除任务和本地文件" : "已删除任务记录"); }

function applyWorkspaceNavigation(view: string, candidateId = "") {
  if (view === "parser" && candidateId) {
    const candidate = store.candidates.find(item => item.id === candidateId);
    if (candidate) { openParser(candidate); pendingCandidateId.value = ""; return; }
    pendingCandidateId.value = candidateId;
  }
  navigate(["resources", "downloads", "settings"].includes(view) ? view : "resources");
  if (view === "resources" && candidateId) void guard(() => store.patchResourceView({ expandedId: candidateId }));
}

function onWorkspaceNavigate(event: Event) {
  const detail = (event as CustomEvent<NonNullable<typeof pendingNavigation>>).detail || {};
  pendingNavigation = detail;
  if (ready) void handleNavigation(detail);
}
async function handleNavigation(detail: NonNullable<typeof pendingNavigation>) {
  floating.value?.restore();
  if (detail.displayMode !== "panel") { floating.value?.setMode("workspace"); applyWorkspaceNavigation(detail.view || "resources", detail.candidateId || ""); }
  await nextTick();
  if (!disposed && detail.attemptId) await sendMessage({ type: "workspace.ready", attemptId: detail.attemptId }).catch(() => {});
}

watch(() => store.candidates, () => {
  if (pendingCandidateId.value) applyWorkspaceNavigation("parser", pendingCandidateId.value);
}, { deep: false });

onMounted(async () => {
  window.addEventListener("streamfirefly-workspace-navigate", onWorkspaceNavigate);
  await store.initialize("workspace");
  if (disposed) return;
  ready = true;
  if (pendingNavigation) await handleNavigation(pendingNavigation);
  if (pendingCandidateId.value) applyWorkspaceNavigation("parser", pendingCandidateId.value);
});
onBeforeUnmount(() => { disposed = true; store.dispose(); clearTimeout(toastTimer); window.removeEventListener("streamfirefly-workspace-navigate", onWorkspaceNavigate); });
</script>

<template>
  <FloatingShell ref="floating" :count="store.candidates.filter(item => item.type !== 'segment').length" :paused="Boolean(store.context?.paused)" :sniffing="Boolean(store.context?.sniffingActive)" :loading="store.loading" :before-leave="beforeLeave" @change="onModeChange" @refresh="store.refresh" @toggle-sniffing="guard(store.toggleSniffing)" @close="guard(store.closeWorkspace)">
    <div class="workspace-shell" :class="{ 'quick-panel': isPanel }">
    <div v-if="store.context" class="floating-source" :title="`${store.context.pageTitle}\n${store.context.pageUrl}`"><img v-if="store.context.favIconUrl" :src="store.context.favIconUrl" alt=""><strong>{{ store.context.pageTitle }}</strong><small>{{ store.context.pageUrl }}</small></div>
    <div v-show="!isPanel" class="workspace-navigation">
    <nav class="primary-nav" aria-label="流萤功能"><div class="primary-nav-inner"><button :class="{ active: tab === 'resources' || tab === 'parser' }" @click="navigate('resources')"><span>资源</span><b>{{ store.candidates.filter(item => item.type !== 'segment').length }}</b></button><button :class="{ active: tab === 'downloads' }" @click="navigate('downloads')"><span>下载</span><b v-if="store.activeTasks.length" class="active-count">{{ store.activeTasks.length }}</b></button><button :class="{ active: tab === 'settings' }" @click="navigate('settings')"><span>设置</span></button></div></nav>
    <button class="button subtle" aria-label="退出工作区" @click="floating?.setMode('panel')">退出工作区</button>
    </div>
    <main class="app-content" :class="{ 'parser-content': tab === 'parser', 'resource-content': tab === 'resources' }">
      <ConnectionBanner :state="store.connection" :error="store.connectionError" @retry="store.refresh" />
      <div v-if="store.error" class="status-banner error">{{ store.error }}</div>
        <ResourcesView v-show="tab === 'resources'" key="resources" :compact="isPanel" :suspended="suspended || tab !== 'resources'" :connected="store.connection === 'ready'" @batch-download="batchCandidates = $event" :candidates="store.candidates" :loading="store.loading" :view-state="store.resourceViewState" @download="openDownload" @capture-blob="captureBlob" @parse="openParser" @inspect="openDetails" @remove="guard(() => store.removeCandidates($event), '已从列表移除资源')" @update-view-state="patch => guard(() => store.patchResourceView(patch))" @metadata="(candidate, metadata) => guard(() => store.updateCandidateMetadata(candidate, metadata))" :external-enabled="Boolean(store.context?.supported)" @external-download="sendExternal"><template #header-tools><ResourceTools :context="store.context" /></template></ResourcesView>
      <Transition name="page" mode="out-in">
        <component :is="parserCandidate?.type === 'dash' ? DashParserView : HlsParserView" v-if="tab === 'parser' && !suspended && parserCandidate && store.context" :key="parserCandidate.id" :candidate="parserCandidate" :context="store.context" :connected="store.connection === 'ready'" :capabilities="store.capabilities" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" @back="parserCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
        <DownloadsView v-else-if="tab === 'downloads'" key="downloads" :connected="store.connection === 'ready'" :tasks="store.tasks" :source-tasks="store.sourceTasks" @control="(task, action, context) => guard(() => store.controlTask(task, action, context))" @delete="handleDelete" />
        <SettingsView v-else-if="tab === 'settings'" ref="settingsView" key="settings" :settings="store.settings" @save="settings => guard(() => store.saveSettings(settings), '设置已保存')" @reset="resetSettings" />
      </Transition>
    </main>
    <footer v-if="isPanel" class="floating-footer"><button class="button primary" :disabled="!store.context?.supported" @click="navigate('resources'); floating?.setMode('workspace')">展开工作区</button><button class="button" @click="navigate('downloads')">下载<span v-if="store.activeTasks.length"> · {{ store.activeTasks.length }}</span></button><button class="button" @click="navigate('settings')">设置</button><div v-if="store.activeTasks.length" class="floating-task-summary"><span v-for="task in store.activeTasks.slice(0, 2)" :key="task.id">{{ task.title || '下载任务' }}</span></div></footer>
    </div>
    <BatchDownloadDialog :candidates="batchCandidates" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :connected="store.connection === 'ready'" @close="batchCandidates = null" @inspect="candidate => { batchCandidates = null; openParser(candidate); }" />
    <DownloadDialog :connected="store.connection === 'ready'" :candidate="downloadCandidate" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :capabilities="store.capabilities" @close="downloadCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
  </FloatingShell>
</template>
