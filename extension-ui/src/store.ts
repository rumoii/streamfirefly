import { computed, onBeforeUnmount, ref } from "vue";
import { defineStore } from "pinia";
import { currentWindowId, extensionApi, sendCore, sendMessage, surfaceFromUrl, type UiSurface } from "./api";
import type { DownloadTask, MediaCandidate, ResourceViewState, UiContext } from "./types";
import { createSettingsState } from "./features/settings/state";
import { createDownloadsState } from "./features/downloads/state";



export const DEFAULT_RESOURCE_VIEW_STATE: Readonly<ResourceViewState> = Object.freeze({
  pattern: "",
  type: "all",
  minMb: "",
  maxMb: "",
  minDuration: "",
  maxDuration: "",
  sortMode: "detected",
  collapsed: false,
  expandedId: "",
  revision: 0
});


export const useAppStore = defineStore("app", () => {
  const surface = ref<UiSurface>(surfaceFromUrl());
  const context = ref<UiContext | null>(null);
  const candidates = ref<MediaCandidate[]>([]);
  const taskState = createDownloadsState(candidates);
  const { activeTasks, controlTask, deleteTask } = taskState;
  const { tasks, capabilities, connection, connectionError } = taskState;
  const loading = ref(true);
  const error = ref("");
  const status = ref("");
  const { settings, loadSettings, saveSettings } = createSettingsState();
  const resourceViewState = ref<ResourceViewState>({ ...DEFAULT_RESOURCE_VIEW_STATE });
  let timer: number | null = null;
  let listening = false;
  let sidebarWindowId: number | null = null;
  let resourcePatchQueue: Promise<void> = Promise.resolve();
  let contextSequence = 0;
  let disposed = false;
  let pendingPatches = 0;

  const sourceTasks = computed(() => tasks.value.filter(task => task.source_context_id && task.source_context_id === context.value?.sourceContextId));

  async function loadContext() {
    const sequence = ++contextSequence;
    if (surface.value === "options") { context.value = null; candidates.value = []; return; }
    if (surface.value === "sidebar" && sidebarWindowId == null) sidebarWindowId = await currentWindowId();
    const result = await sendCore({ type: "ui.context.get", scope: surface.value === "workspace" ? "sender" : "active", windowId: sidebarWindowId }).catch(reason => {
      if (disposed || sequence !== contextSequence) return null;
      throw reason;
    });
    if (disposed || sequence !== contextSequence) return;
    if (!result?.ok || !result.context) throw new Error(result?.error || "source_tab_unavailable");
    const nextContext = result.context as UiContext;
    nextContext.pageTitle = cleanSourceTitle(nextContext.pageTitle);
    nextContext.resourceViewState = { ...DEFAULT_RESOURCE_VIEW_STATE, ...(nextContext.resourceViewState || {}), sortMode: nextContext.resourceViewState?.sortMode || settings.value.candidateSort };
    const sameContext = context.value?.sourceContextId === nextContext.sourceContextId;
    context.value = nextContext;
    candidates.value = Array.isArray(result.context?.candidates) ? result.context.candidates : [];
    if (!sameContext || (!pendingPatches && nextContext.resourceViewState.revision >= resourceViewState.value.revision)) resourceViewState.value = { ...nextContext.resourceViewState };
    error.value = "";
    if (surface.value !== "workspace") document.title = `流萤 · ${context.value?.pageTitle || "网页媒体"}`;
  }

  const loadTasks = taskState.refresh;


  async function initialize(nextSurface: UiSurface = surfaceFromUrl()) {
    surface.value = nextSurface;
    loading.value = true;
    error.value = "";
    try {
      if (!extensionApi()?.runtime?.sendMessage) {
        context.value = { sourceContextId: "preview-page", sourceTabId: 1, pageUrl: "https://media.example/demo", pageTitle: "示例媒体页面", favIconUrl: "", supported: true, paused: false, resourceViewState: { ...DEFAULT_RESOURCE_VIEW_STATE }, candidates: previewCandidates() };
        candidates.value = context.value.candidates;
        resourceViewState.value = { ...context.value.resourceViewState };
        tasks.value = previewTasks();
        connection.value = "ready";
        capabilities.value = ["hls-selection-v1", "hls-subtitle-sidecar-v1", "task-output-group-v1", "hls-segment-engine-v1", "hls-checkpoint-v1", "hls-aes128-v1", "hls-key-override-v1", "hls-reauthorize-v1", "hls-live-engine-v1"];
      } else {
        await loadSettings();
        if (disposed) return;
        const api = extensionApi();
        if (!listening) { api.runtime.onMessage.addListener(onRuntimeMessage); listening = true; }
        if (surface.value !== "options") {
          document.addEventListener("visibilitychange", onVisibilityChange);
          await refresh();
          scheduleRefresh();
        }
      }
    } catch (reason: any) {
      error.value = humanError(reason?.message || String(reason));
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    if (disposed || !extensionApi()?.runtime?.sendMessage || surface.value === "options") return;
    await Promise.all([loadContext().catch(reason => { if (!disposed) error.value = humanError(reason?.message); }), loadTasks()]);
  }

  function scheduleRefresh() {
    if (disposed || document.hidden || timer != null) return;
    timer = window.setTimeout(async () => { timer = null; await refresh(); scheduleRefresh(); }, 1000);
  }

  function onVisibilityChange() {
    if (timer != null) { clearTimeout(timer); timer = null; }
    if (!document.hidden) void refresh().finally(scheduleRefresh);
  }

  async function toggleSniffing() {
    if (!context.value?.supported || !Number.isInteger(context.value.sourceTabId)) return;
    const result: any = await sendMessage({ type: "media.sniffing.set", tabId: context.value.sourceTabId, payload: { paused: !context.value.paused } });
    if (!result?.ok) throw new Error(result?.error || "sniffing_update_failed");
    context.value.paused = Boolean(result.paused);
  }

  async function openWorkspace(view = "resources", candidateId = "") {
    if (!context.value?.supported) throw new Error("workspace_page_unsupported");
    const result: any = await sendMessage({ type: "workspace.open", view, candidateId, windowId: sidebarWindowId });
    if (!result?.ok) throw new Error(result?.error || "workspace_injection_failed");
  }

  async function closeWorkspace() {
    if (!window.dispatchEvent(new Event("streamfirefly-workspace-before-close", { cancelable: true }))) return;
    const result: any = await sendMessage({ type: "workspace.close" });
    if (!result?.ok) throw new Error(result?.error || "workspace_close_failed");
  }

  async function removeCandidates(ids: string[]) {
    if (!context.value?.supported) return;
    const result: any = await sendMessage({ type: "media.remove", tabId: context.value.sourceTabId, payload: { ids } });
    if (!result?.ok) throw new Error(result?.error || "media_remove_failed");
    candidates.value = candidates.value.filter(item => !ids.includes(item.id));
  }

  function patchResourceView(patch: Partial<Omit<ResourceViewState, "revision">>): Promise<void> {
    if (!context.value?.supported) return Promise.resolve();
    const sourceContextId = context.value.sourceContextId;
    resourceViewState.value = { ...resourceViewState.value, ...patch, revision: resourceViewState.value.revision + 1 };
    let sortPersistence: Promise<unknown> = Promise.resolve();
    if (patch.sortMode) {
      settings.value.candidateSort = patch.sortMode;
      sortPersistence = extensionApi()?.storage?.local?.set?.({ candidateSort: patch.sortMode }) || Promise.resolve();
    }
    if (!extensionApi()?.runtime?.sendMessage) return Promise.resolve();
    const tabId = context.value.sourceTabId;
    pendingPatches++;
    const operation = resourcePatchQueue.catch(() => {}).then(async () => {
      if (disposed || context.value?.sourceContextId !== sourceContextId) return;
      await sortPersistence;
      const result = await sendCore({ type: "ui.resource-state.patch", scope: surface.value === "workspace" ? "sender" : "active", tabId, windowId: sidebarWindowId, sourceContextId, patch });
      if (!result?.ok) throw new Error(result?.error || "resource_view_update_failed");
      if (!disposed && context.value?.sourceContextId === sourceContextId && result.state && result.state.revision >= resourceViewState.value.revision) resourceViewState.value = result.state;
    }).finally(() => { pendingPatches--; });
    resourcePatchQueue = operation.catch(() => {});
    return operation;
  }

  async function updateCandidateMetadata(candidate: MediaCandidate, metadata: Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">>) {
    if (!context.value?.supported) return;
    if (!extensionApi()?.runtime?.sendMessage) {
      const index = candidates.value.findIndex(item => item.id === candidate.id);
      if (index >= 0) candidates.value[index] = { ...candidates.value[index], ...metadata };
      return;
    }
    const result: any = await sendMessage({ type: "media.metadata.update", tabId: context.value.sourceTabId, sourceContextId: context.value.sourceContextId, payload: { id: candidate.id, url: candidate.url, ...metadata } });
    if (!result?.ok) throw new Error(result?.error || "media_metadata_update_failed");
    const index = candidates.value.findIndex(item => item.id === candidate.id);
    if (index >= 0 && result.candidate) candidates.value[index] = { ...candidates.value[index], ...result.candidate };
  }



  function onRuntimeMessage(message: any) {
    if (disposed) return;
    taskState.receive(message);
    if (message?.type === "ui.context.changed") {
      const belongsToSidebar = surface.value === "sidebar" && (message.windowId == null || sidebarWindowId == null || message.windowId === sidebarWindowId);
      const belongsToWorkspace = surface.value === "workspace" && message.tabId === context.value?.sourceTabId;
      if (belongsToSidebar || belongsToWorkspace) void loadContext().catch(() => {});
    }
    if (message?.type === "ui.resource-state.changed" && message.sourceContextId === context.value?.sourceContextId && message.state?.revision >= resourceViewState.value.revision) resourceViewState.value = message.state;
  }

  onBeforeUnmount(() => {
    disposed = true;
    contextSequence++;
    taskState.dispose();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    if (timer != null) { clearTimeout(timer); timer = null; }
    if (listening) { extensionApi()?.runtime?.onMessage?.removeListener?.(onRuntimeMessage); listening = false; }
  });

  return { surface, context, candidates, tasks, capabilities, connection, connectionError, loading, error, status, settings, resourceViewState, sourceTasks, activeTasks, initialize, refresh, toggleSniffing, openWorkspace, closeWorkspace, removeCandidates, patchResourceView, updateCandidateMetadata, saveSettings, controlTask, deleteTask };
});

export function cleanSourceTitle(value: string): string {
  return String(value || "").replace(/^(?:(?:流萤(?:\s+StreamFirefly)?)[\s·|\-–—:：]+)+/i, "").trim() || "未命名页面";
}

export function humanError(value: string): string {
  const labels: Record<string, string> = {
    source_tab_unavailable: "当前窗口没有可用的来源标签页。",
    workspace_page_unsupported: "当前页面属于浏览器内部或受限页面，不能展开工作区。",
    workspace_injection_failed: "无法在当前页面展开工作区，请检查页面权限后重试。",
    workspace_close_failed: "工作区未能正常收起，请刷新页面后重试。",
    native_host_unavailable: "未连接到本地助手，请安装或重新启动流萤本地助手。",
    native_host_incompatible: "请同时更新扩展与本地助手，不支持旧版混用。",
    native_host_disconnected: "任务记录已保留。请启动本地助手后重新连接。",
    task_store_write_failed: "任务状态未能保存，请检查磁盘空间和权限。",
    task_store_format_unsupported: "任务文件格式不支持，原文件未改动；请单独备份或重置。",
    live_capacity_unavailable: "下载名额已满，请暂停一个任务后再开始直播录制。",
    native_host_timeout: "本地助手响应超时，请重启后重试。",
    dash_native_upgrade_required: "请同时更新扩展与本地助手后使用 DASH 下载。",
    dash_plan_expired: "DASH 计划已失效，请回到资源页重新解析并创建任务。",
    dash_plan_required: "请先解析 DASH 并选择轨道。",
    dash_container_incompatible: "所选编码不适合 MP4，请改用 MKV。",
    hls_selection_native_upgrade_required: "请同时更新扩展与本地助手后重试。",
    inline_hls_native_upgrade_required: "请同时更新扩展与本地助手后重试。",
    hls_live_native_upgrade_required: "请同时更新扩展与本地助手后录制直播。",
    hls_plan_expired: "本地助手重启后无法恢复该 HLS 选择计划，请从资源页重新解析并创建任务。",
    hls_authorization_required: "请回到仍保持登录的来源页面，重新播放资源后再授权继续。",
    hls_key_required: "请重新输入 AES-128 密钥后继续。",
    hls_source_candidate_missing: "当前页面已找不到原资源，请重新播放并嗅探。",
    hls_key_override_invalid: "自定义 AES-128 密钥或 IV 格式无效。",
    hls_key_validation_failed: "AES-128 密钥未能解开首个媒体切片，请检查密钥和 IV。",
    hls_map_iv_required: "该 HLS 的加密初始化片段缺少规范要求的显式 IV。",
    hls_encryption_unsupported: "该 HLS 使用了暂不支持的加密方式；流萤不会绕过 DRM。",
    hls_checkpoint_invalid: "HLS 检查点已损坏，请重新创建下载任务。",
    hls_checkpoint_version_unsupported: "HLS 检查点版本不兼容，请升级本地助手或重新创建任务。",
    hls_live_not_supported: "当前版本暂不支持直播 M3U8 录制。",
    path_not_writable: "保存目录不可写，请检查路径和权限。"
  };
  return labels[value] || value || "未知错误";
}

function previewCandidates(): MediaCandidate[] {
  const hlsPoster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23182220'/%3E%3Ccircle cx='495' cy='82' r='74' fill='%232d6961'/%3E%3Cpath d='M0 292 162 142l104 93 92-78 282 203H0Z' fill='%232c4743'/%3E%3Cpath d='M0 325 174 178l94 84 91-71 281 169H0Z' fill='%233c5c57'/%3E%3C/svg%3E";
  const videoPoster = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 640 360'%3E%3Crect width='640' height='360' fill='%23202625'/%3E%3Crect x='52' y='48' width='536' height='264' rx='18' fill='%23303937'/%3E%3Ccircle cx='320' cy='180' r='58' fill='%231b8b7e'/%3E%3Cpath d='m303 147 49 33-49 33Z' fill='white'/%3E%3C/svg%3E";
  return [
    { id: "demo-hls", type: "hls", url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", mime: "application/vnd.apple.mpegurl", size: 4096, sizeKind: "manifest", width: 1920, height: 1080, duration: 634, poster: hlsPoster, pageTitle: "示例 HLS 视频", detectedAt: Date.now(), source: "network" },
    { id: "demo-video", type: "video", url: "https://media.example/flower.mp4", mime: "video/mp4", size: 112837500, width: 1920, height: 1080, duration: 120, poster: videoPoster, pageTitle: "示例视频", detectedAt: Date.now() - 1000, source: "dom" },
    { id: "demo-audio", type: "audio", url: "https://media.example/sample.mp3", mime: "audio/mpeg", size: 4832000, duration: 180, pageTitle: "示例音频", detectedAt: Date.now() - 2000, source: "network" }
  ];
}

function previewTasks(): DownloadTask[] {
  return [{ id: "preview-task", title: "示例视频", state: "running", phase: "downloading_segments", progress: 42, downloaded_bytes: 42_000_000, total_bytes: null, speed_bytes_per_second: 5_200_000, eta_seconds: 11, segments_completed: 126, segments_total: 300, failed_segments: 0, retry_count: 2, checkpoint_state: "active", output: "D:\\Downloads\\示例视频.mp4", source_context_id: "preview-page", outputs: [{ kind: "media", path: "D:\\Downloads\\示例视频.mp4", state: "running" }] } as DownloadTask];
}
