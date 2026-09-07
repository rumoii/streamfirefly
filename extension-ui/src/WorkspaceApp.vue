<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useAppStore, humanError } from "./store";
import type { DownloadTask, MediaCandidate } from "./types";
import AppHeader from "./components/AppHeader.vue";
import ResourcesView from "./components/ResourcesView.vue";
import BatchDownloadDialog from "./components/BatchDownloadDialog.vue";
import ConnectionBanner from "./components/ConnectionBanner.vue";
import DownloadsView from "./components/DownloadsView.vue";
import SettingsView from "./components/SettingsView.vue";
import ExternalAction from "./features/configuration/ExternalAction.vue";
import DownloadDialog from "./components/DownloadDialog.vue";
import HlsParserView from "./components/HlsParserView.vue";

const store = useAppStore();
const route = ref("resources");
const parserCandidate = ref<MediaCandidate | null>(null);
const downloadCandidate = ref<MediaCandidate | null>(null);
const batchCandidates = ref<MediaCandidate[] | null>(null);
const pendingCandidateId = ref("");
const toast = ref("");
let toastTimer = 0;
const tab = computed(() => parserCandidate.value ? "parser" : route.value);
watch(() => store.context?.sourceContextId, (next, previous) => { if (previous && next !== previous) { downloadCandidate.value = null; parserCandidate.value = null; } });

function showToast(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.value = "", 3500); }
function navigate(value: string) { parserCandidate.value = null; route.value = value; }
async function guard(action: () => Promise<any>, success?: string) { try { await action(); if (success) showToast(success); } catch (reason: any) { showToast(humanError(reason?.message)); } }
async function resetSettings() { const next = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, candidateSort: store.settings.candidateSort }; await guard(() => store.saveSettings(next), "已恢复默认设置"); }
function openParser(candidate: MediaCandidate) { if (candidate.type !== "hls") { showToast("当前版本暂未提供 DASH 轨道选择，将按完整清单下载。"); downloadCandidate.value = candidate; return; } parserCandidate.value = candidate; }
function handleDelete(task: DownloadTask, deleteFile: boolean) { void guard(() => store.deleteTask(task, deleteFile), deleteFile ? "已删除任务和本地文件" : "已删除任务记录"); }

function applyWorkspaceNavigation(view: string, candidateId = "") {
  if (view === "parser" && candidateId) {
    const candidate = store.candidates.find(item => item.id === candidateId);
    if (candidate) { openParser(candidate); pendingCandidateId.value = ""; return; }
    pendingCandidateId.value = candidateId;
  }
  navigate(["resources", "downloads", "settings"].includes(view) ? view : "resources");
}

function onWorkspaceNavigate(event: Event) {
  const detail = (event as CustomEvent<{ view?: string; candidateId?: string }>).detail || {};
  applyWorkspaceNavigation(detail.view || "resources", detail.candidateId || "");
}

watch(() => store.candidates, () => {
  if (pendingCandidateId.value) applyWorkspaceNavigation("parser", pendingCandidateId.value);
}, { deep: false });

onMounted(async () => {
  window.addEventListener("streamfirefly-workspace-navigate", onWorkspaceNavigate);
  await store.initialize("workspace");
  if (pendingCandidateId.value) applyWorkspaceNavigation("parser", pendingCandidateId.value);
});
onBeforeUnmount(() => { clearTimeout(toastTimer); window.removeEventListener("streamfirefly-workspace-navigate", onWorkspaceNavigate); });
</script>

<template>
  <div class="app-shell workspace-shell" tabindex="-1">
    <AppHeader :context="store.context" :loading="store.loading" @refresh="store.refresh" @toggle-sniffing="guard(store.toggleSniffing)" />
    <button class="workspace-close button subtle" type="button" aria-label="收起流萤工作区" @click="guard(store.closeWorkspace)">收起</button>
    <nav class="primary-nav" aria-label="流萤功能"><div class="primary-nav-inner"><button :class="{ active: tab === 'resources' || tab === 'parser' }" @click="navigate('resources')"><span>资源</span><b>{{ store.candidates.filter(item => item.type !== 'segment').length }}</b></button><button :class="{ active: tab === 'downloads' }" @click="navigate('downloads')"><span>下载</span><b v-if="store.activeTasks.length" class="active-count">{{ store.activeTasks.length }}</b></button><button :class="{ active: tab === 'settings' }" @click="navigate('settings')"><span>设置</span></button></div></nav>
    <main class="app-content" :class="{ 'parser-content': tab === 'parser' }">
      <ConnectionBanner :state="store.connection" :error="store.connectionError" @retry="store.refresh" />
      <ExternalAction v-if="tab === 'resources'" :candidates="store.candidates" :context="store.context" />
      <div v-if="store.error" class="status-banner error">{{ store.error }}</div>
      <Transition name="page" mode="out-in">
        <ResourcesView v-if="tab === 'resources'" key="resources" :connected="store.connection === 'ready'" @batch-download="batchCandidates = $event" :candidates="store.candidates" :loading="store.loading" :view-state="store.resourceViewState" @download="downloadCandidate = $event" @parse="openParser" @remove="guard(() => store.removeCandidates($event), '已从列表移除资源')" @update-view-state="patch => guard(() => store.patchResourceView(patch))" @metadata="(candidate, metadata) => guard(() => store.updateCandidateMetadata(candidate, metadata))" />
        <HlsParserView v-else-if="tab === 'parser' && parserCandidate && store.context" key="parser" :candidate="parserCandidate" :context="store.context" :connected="store.connection === 'ready'" :capabilities="store.capabilities" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" @back="parserCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
        <DownloadsView v-else-if="tab === 'downloads'" key="downloads" :connected="store.connection === 'ready'" :tasks="store.tasks" :source-tasks="store.sourceTasks" @control="(task, action, context) => guard(() => store.controlTask(task, action, context))" @delete="handleDelete" />
        <SettingsView v-else key="settings" :settings="store.settings" @save="settings => guard(() => store.saveSettings(settings), '设置已保存')" @reset="resetSettings" />
      </Transition>
    </main>
    <BatchDownloadDialog :candidates="batchCandidates" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :connected="store.connection === 'ready'" @close="batchCandidates = null" @inspect="candidate => { batchCandidates = null; openParser(candidate); }" />
    <DownloadDialog :connected="store.connection === 'ready'" :candidate="downloadCandidate" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.context?.sourceContextId || null" :source-tab-id="store.context?.sourceTabId ?? null" :capabilities="store.capabilities" @close="downloadCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
  </div>
</template>
