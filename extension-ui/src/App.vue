<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { extensionApi } from "./api";
import { useAppStore, humanError } from "./store";
import type { DownloadTask, MediaCandidate } from "./types";
import AppHeader from "./components/AppHeader.vue";
import ResourcesView from "./components/ResourcesView.vue";
import DownloadsView from "./components/DownloadsView.vue";
import SettingsView from "./components/SettingsView.vue";
import DownloadDialog from "./components/DownloadDialog.vue";
import HlsParserView from "./components/HlsParserView.vue";

const store = useAppStore();
const route = ref(location.hash.includes("settings") ? "settings" : "resources");
const parserCandidate = ref<MediaCandidate | null>(null);
const downloadCandidate = ref<MediaCandidate | null>(null);
const toast = ref("");
let toastTimer = 0;
const tab = computed(() => parserCandidate.value ? "parser" : route.value);

function showToast(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = window.setTimeout(() => toast.value = "", 3500); }
function navigate(value: string) { parserCandidate.value = null; route.value = value; location.hash = `/${value}`; }
async function guard(action: () => Promise<any>, success?: string) { try { await action(); if (success) showToast(success); } catch (reason: any) { showToast(humanError(reason?.message)); } }
async function updateSort(mode: string) { store.settings.candidateSort = mode; if (extensionApi()?.storage?.local) await extensionApi().storage.local.set({ candidateSort: mode }); }
async function resetSettings() { const next = { saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, candidateSort: store.settings.candidateSort }; await guard(() => store.saveSettings(next), "已恢复默认设置"); }
function openParser(candidate: MediaCandidate) { if (candidate.type !== "hls") { showToast("Beta 1 暂未提供 DASH 轨道选择，将按完整清单下载。"); downloadCandidate.value = candidate; return; } parserCandidate.value = candidate; }
function handleDelete(task: DownloadTask, deleteFile: boolean) { void guard(() => store.deleteTask(task, deleteFile), deleteFile ? "已删除任务和本地文件" : "已删除任务记录"); }

onMounted(store.initialize);
</script>

<template>
  <div class="app-shell">
    <AppHeader :session="store.session" :loading="store.loading" @refresh="store.refresh" @toggle-sniffing="guard(store.toggleSniffing)" @focus-source="guard(store.focusSource)" />
    <nav class="primary-nav" aria-label="流萤功能"><div class="primary-nav-inner"><button :class="{ active: tab === 'resources' || tab === 'parser' }" @click="navigate('resources')"><span>资源</span><b>{{ store.candidates.filter(item => item.type !== 'segment').length }}</b></button><button :class="{ active: tab === 'downloads' }" @click="navigate('downloads')"><span>下载</span><b v-if="store.activeTasks.length" class="active-count">{{ store.activeTasks.length }}</b></button><button :class="{ active: tab === 'settings' }" @click="navigate('settings')"><span>设置</span></button></div></nav>
    <main class="app-content" :class="{ 'parser-content': tab === 'parser' }">
      <div v-if="store.error" class="status-banner error">{{ store.error }}</div>
      <div v-if="store.session?.sourceClosed" class="status-banner warning"><strong>来源页面已关闭</strong><span>已发现资源和当前页面任务会保留到此流萤页关闭，但不会继续嗅探新资源。</span></div>
      <div v-else-if="store.session && !store.session.supported && tab !== 'settings'" class="status-banner warning"><strong>当前页面不支持嗅探</strong><span>浏览器内部页面、扩展页面和本地受限页面无法读取媒体请求。</span></div>
      <Transition name="page" mode="out-in">
        <ResourcesView v-if="tab === 'resources'" key="resources" :candidates="store.candidates" :loading="store.loading" :sort-mode="store.settings.candidateSort" @download="downloadCandidate = $event" @parse="openParser" @remove="guard(() => store.removeCandidates($event), '已从列表移除资源')" @update-sort="updateSort" />
        <HlsParserView v-else-if="tab === 'parser' && parserCandidate && store.session" key="parser" :candidate="parserCandidate" :session="store.session" :capabilities="store.capabilities" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" @back="parserCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
        <DownloadsView v-else-if="tab === 'downloads'" key="downloads" :tasks="store.tasks" :source-tasks="store.sourceTasks" @control="(task, action) => guard(() => store.controlTask(task, action))" @delete="handleDelete" />
        <SettingsView v-else key="settings" :settings="store.settings" @save="settings => guard(() => store.saveSettings(settings), '设置已保存')" @reset="resetSettings" />
      </Transition>
    </main>
    <DownloadDialog :candidate="downloadCandidate" :save-dir="store.settings.saveDir" :download-threads="store.settings.downloadThreads" :source-context-id="store.session?.sourceContextId || null" :source-tab-id="store.session?.sourceTabId || null" :capabilities="store.capabilities" @close="downloadCandidate = null" @created="message => { showToast(message); navigate('downloads'); }" />
    <Transition name="toast"><div v-if="toast" class="toast" role="status">{{ toast }}</div></Transition>
  </div>
</template>
