<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from "vue";
import { useAppStore, humanError } from "./store";
import type { DownloadTask, MediaCandidate } from "./types";
import FloatingShell from "./components/FloatingShell.vue";
import type { DisplayMode } from "./floating-layout";
import { sendMessage } from "./api";
import ResourcesView from "./components/ResourcesView.vue";
import BatchDownloadDialog from "./components/BatchDownloadDialog.vue";
import ConnectionBanner from "./components/ConnectionBanner.vue";
import UpdateBanner from "./components/UpdateBanner.vue";
import DownloadsView from "./components/DownloadsView.vue";
import SettingsView from "./components/SettingsView.vue";
import ResourceTools from "./features/configuration/ResourceTools.vue";
import DeepSearchHint from "./features/configuration/DeepSearchHint.vue";
import { createDeepSearchState, deepSearchKey } from "./features/deep-search/state";
import { openCapture, openDispatch } from "./features/configuration/client";
import DownloadDialog from "./components/DownloadDialog.vue";
import DashParserView from "./components/DashParserView.vue";
import HlsParserView from "./components/HlsParserView.vue";

const store = useAppStore();
provide(deepSearchKey, createDeepSearchState(computed(() => store.context)));
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
const resourceCount = computed(() => store.candidates.filter(item => item.type !== "segment").length);
watch(() => store.context?.sourceContextId, (next, previous) => { if (previous && next !== previous) { downloadCandidate.value = null; parserCandidate.value = null; } });

function showToast(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.value = "", 3500); }
function beforeLeave() { return !settingsView.value?.hasUnsavedChanges || window.confirm("设置尚未保存，确定放弃修改吗？"); }
function onModeChange(mode: DisplayMode) { displayMode.value = mode; if (mode === "panel") { parserCandidate.value = null; if (route.value === "settings") route.value = "resources"; } }
function navigate(value: string) { if (value !== tab.value && !beforeLeave()) return; parserCandidate.value = null; route.value = value; if (value === "settings" && isPanel.value) floating.value?.setMode("workspace"); }
async function guard(action: () => Promise<any>, success?: string) { try { await action(); if (success) showToast(success); } catch (reason: any) { showToast(humanError(reason?.message)); } }
async function resetSettings() { const next = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, sniffMode: "on_open" as const, candidateSort: store.settings.candidateSort, proxyMode: "system" as const, proxyUrl: "", fileNaming: "page_title" as const, siteFolders: true }; await guard(() => store.saveSettings(next), "已恢复默认设置"); }
function openParser(candidate: MediaCandidate) { if (["hls", "dash"].includes(candidate.type) && beforeLeave()) { floating.value?.setMode("workspace"); parserCandidate.value = candidate; } }
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
  else if (detail.candidateId) applyWorkspaceNavigation(detail.view || "resources", detail.candidateId);
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
  <FloatingShell ref="floating" :count="resourceCount" :paused="Boolean(store.context?.paused)" :sniffing="Boolean(store.context?.sniffingActive)" :loading="store.loading" :can-expand="Boolean(store.context?.supported)" :before-leave="beforeLeave" @change="onModeChange" @refresh="store.refresh" @toggle-sniffing="guard(store.toggleSniffing)" @close="guard(store.closeWorkspace)">
    <template #source><template v-if="store.context"><img v-if="store.context.favIconUrl" :src="store.context.favIconUrl" alt=""><span :title="`${store.context.pageTitle}\n${store.context.pageUrl}`">{{ store.context.pageTitle || store.context.pageUrl }}</span></template></template>
    <div class="workspace-shell" :class="{ 'quick-panel': isPanel }">
    <nav class="primary-nav" aria-label="流萤功能">
      <button :class="{ active: tab === 'resources' || tab === 'parser' }" :aria-current="tab === 'resources' || tab === 'parser' ? 'page' : undefined" @click="navigate('resources')"><span>资源</span><b>{{ resourceCount }}</b></button>
      <button :class="{ active: tab === 'downloads' }" :aria-current="tab === 'downloads' ? 'page' : undefined" @click="navigate('downloads')"><span>下载</span><b v-if="store.activeTasks.length" class="active-count">{{ store.activeTasks.length }}</b></button>
      <button :class="{ active: tab === 'settings' }" :aria-current="tab === 'settings' ? 'page' : undefined" :title="isPanel ? '在工作区中打开设置' : undefined" @click="navigate('settings')"><span>设置</span></button>
    </nav>
    <main class="app-content" :class="{ 'parser-content': tab === 'parser', 'resource-content': tab === 'resources' || tab === 'downloads' }">
      <ConnectionBanner :state="store.connection" :error="store.connectionError" @retry="store.refresh" />
      <UpdateBanner />
      <div v-if="store.error" class="status-banner error">{{ store.error }}</div>
        <ResourcesView v-show="tab === 'resources'" key="resources" :compact="isPanel" :suspended="suspended || tab !== 'resources'" :connected="store.connection === 'ready'" @batch-download="batchCandidates = $event" :candidates="store.candidates" :loading="store.loading" :view-state="store.resourceViewState" @download="openDownload" @capture-blob="captureBlob" @parse="openParser" @remove="guard(() => store.removeCandidates($event), '已从列表移除资源')" @update-view-state="patch => guard(() => store.patchResourceView(patch))" @metadata="(candidate, metadata) => guard(() => store.updateCandidateMetadata(candidate, metadata))" :external-enabled="Boolean(store.context?.supported)" @external-download="sendExternal"><template #header-tools><ResourceTools :context="store.context" /></template><template #hints><DeepSearchHint :context="store.context" /></template></ResourcesView>
      <Transition name="page" mode="out-in">
        <component :is="parserCandidate?.type === 'dash' ? DashParserView : HlsParserView" v-if="tab === 'parser' && !suspended && parserCandidate && store.context" :key="parserCandidate.id" :candidate="parserCandidate" :context="store.context" :connected="store.connection === 'ready'" :capabilities="store.capabilities" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" @back="parserCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
        <DownloadsView v-else-if="tab === 'downloads'" key="downloads" :compact="isPanel" :context="store.context" :suspended="suspended" :connected="store.connection === 'ready'" :tasks="store.tasks" :source-tasks="store.sourceTasks" @control="(task, action, context) => guard(() => store.controlTask(task, action, context))" @delete="handleDelete" />
        <SettingsView v-else-if="tab === 'settings'" ref="settingsView" key="settings" :settings="store.settings" @save="settings => guard(() => store.saveSettings(settings), '设置已保存')" @reset="resetSettings" />
      </Transition>
    </main>
    </div>
    <BatchDownloadDialog :candidates="batchCandidates" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :connected="store.connection === 'ready'" @close="batchCandidates = null" @inspect="candidate => { batchCandidates = null; openParser(candidate); }" />
    <DownloadDialog :connected="store.connection === 'ready'" :candidate="downloadCandidate" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :capabilities="store.capabilities" @close="downloadCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
  </FloatingShell>
</template>
