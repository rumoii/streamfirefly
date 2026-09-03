import { computed, onBeforeUnmount, ref } from "vue";
import { defineStore } from "pinia";
import { extensionApi, sendMessage, sessionIdFromUrl } from "./api";
import type { DownloadTask, MediaCandidate, PageContext } from "./types";

const activeStates = new Set(["queued", "starting", "running", "retrying", "pausing", "cancelling"]);

export const useAppStore = defineStore("app", () => {
  const sessionId = sessionIdFromUrl();
  const session = ref<PageContext | null>(null);
  const candidates = ref<MediaCandidate[]>([]);
  const tasks = ref<DownloadTask[]>([]);
  const capabilities = ref<string[]>([]);
  const loading = ref(true);
  const error = ref("");
  const status = ref("");
  const settings = ref({ saveDir: "", downloadThreads: 6, detectImages: false, advancedDeepSearch: false, candidateSort: "detected" });
  let timer: number | null = null;

  const sourceTasks = computed(() => tasks.value.filter(task => task.source_context_id && task.source_context_id === session.value?.sourceContextId));
  const activeTasks = computed(() => tasks.value.filter(task => activeStates.has(task.state)));

  async function loadSession() {
    const result: any = await sendMessage({ type: "app.session.get", sessionId });
    if (!result?.ok) throw new Error(result?.error || "app_session_not_found");
    session.value = result.session;
    candidates.value = Array.isArray(result.candidates) ? result.candidates : [];
    document.title = `流萤 · ${session.value?.pageTitle || "网页媒体"}`;
  }

  async function loadTasks() {
    const result: any = await sendMessage({ type: "task.list" });
    tasks.value = result?.tasks ?? result?.payload?.tasks ?? [];
  }

  async function loadSettings() {
    const api = extensionApi();
    if (!api?.storage?.local) return;
    settings.value = await api.storage.local.get(settings.value);
  }

  async function initialize() {
    loading.value = true;
    error.value = "";
    try {
      if (!extensionApi()?.runtime?.sendMessage) {
        session.value = { sessionId: "preview", sourceContextId: "preview-page", sourceTabId: 1, appTabId: 2, pageUrl: "https://media.example/demo", pageTitle: "示例媒体页面", favIconUrl: "", sourceClosed: false, supported: true, paused: false };
        candidates.value = previewCandidates();
        tasks.value = previewTasks();
        capabilities.value = ["hls-selection-v1", "hls-subtitle-sidecar-v1", "task-output-group-v1", "hls-segment-engine-v1", "hls-checkpoint-v1", "hls-aes128-v1", "hls-key-override-v1", "hls-reauthorize-v1"];
      } else {
        const native: any = await sendMessage({ type: "native.connect" });
        capabilities.value = native?.capabilities || [];
        const settingsOnly = !new URLSearchParams(location.search).has("session") && location.hash.includes("settings");
        if (settingsOnly) {
          session.value = null;
          await Promise.all([loadTasks(), loadSettings()]);
        } else await Promise.all([loadSession(), loadTasks(), loadSettings()]);
        const api = extensionApi();
        api.runtime.onMessage.addListener(onRuntimeMessage);
        if (!settingsOnly) timer = window.setInterval(() => { void refresh(); }, 1000);
      }
    } catch (reason: any) {
      error.value = humanError(reason?.message || String(reason));
    } finally {
      loading.value = false;
    }
  }

  async function refresh() {
    if (!extensionApi()?.runtime?.sendMessage) return;
    try { await Promise.all([loadSession(), loadTasks()]); } catch (_) {}
  }

  async function toggleSniffing() {
    if (!session.value || session.value.sourceClosed || !Number.isInteger(session.value.sourceTabId)) return;
    const result: any = await sendMessage({ type: "media.sniffing.set", tabId: session.value.sourceTabId, payload: { paused: !session.value.paused } });
    if (!result?.ok) throw new Error(result?.error || "sniffing_update_failed");
    session.value.paused = Boolean(result.paused);
  }

  async function focusSource() { await sendMessage({ type: "app.source.focus", sessionId }); }

  async function removeCandidates(ids: string[]) {
    if (!session.value?.sourceTabId) return;
    const result: any = await sendMessage({ type: "media.remove", tabId: session.value.sourceTabId, payload: { ids } });
    if (!result?.ok) throw new Error(result?.error || "media_remove_failed");
    candidates.value = candidates.value.filter(item => !ids.includes(item.id));
  }

  async function saveSettings(next = settings.value) {
    if (next.saveDir.trim()) {
      const result: any = await sendMessage({ type: "path.validate", payload: { path: next.saveDir.trim() } });
      if (!result?.ok) throw new Error(result?.error || "path_not_writable");
    }
    const normalized = { ...next, saveDir: next.saveDir.trim(), downloadThreads: Math.max(1, Math.min(16, Number(next.downloadThreads) || 6)) };
    await extensionApi().storage.local.set(normalized);
    settings.value = normalized;
  }

  async function controlTask(task: DownloadTask, action: string, suppliedContext: any = null) {
    const resumeContext: any = suppliedContext ? { ...suppliedContext } : {};
    if (task.resume_requirement?.includes("authorization")) {
      const candidate = candidates.value.find(item => item.id === task.source_candidate_id) || candidates.value.find(item => item.url === task.url);
      if (!candidate) throw new Error("hls_source_candidate_missing");
      resumeContext.requestHeaders = candidate.requestHeaders || {};
      resumeContext.referer = candidate.referer || candidate.pageUrl || null;
    }
    const result: any = await sendMessage({ type: "task.control", payload: { id: task.id, action, resumeContext: Object.keys(resumeContext).length ? resumeContext : null } });
    if (!result?.ok) throw new Error(result?.error || "task_control_failed");
    const index = tasks.value.findIndex(item => item.id === task.id);
    if (index >= 0 && result.task) tasks.value[index] = result.task;
  }

  async function deleteTask(task: DownloadTask, deleteFile: boolean) {
    const result: any = await sendMessage({ type: "task.delete", payload: { id: task.id, deleteFile } });
    if (!result?.ok) throw new Error(result?.error || "task_delete_failed");
    tasks.value = tasks.value.filter(item => item.id !== task.id);
  }

  function onRuntimeMessage(message: any) {
    if (message?.type === "task.deleted" && message.id) tasks.value = tasks.value.filter(item => item.id !== message.id);
    if (message?.type === "task.progress" && message.task) {
      const index = tasks.value.findIndex(item => item.id === message.task.id);
      if (index >= 0) tasks.value[index] = message.task; else tasks.value.push(message.task);
    }
  }

  onBeforeUnmount(() => {
    if (timer != null) clearInterval(timer);
    extensionApi()?.runtime?.onMessage?.removeListener?.(onRuntimeMessage);
    void sendMessage({ type: "preview.headers.clear" }).catch(() => {});
  });

  return { sessionId, session, candidates, tasks, capabilities, loading, error, status, settings, sourceTasks, activeTasks, initialize, refresh, toggleSniffing, focusSource, removeCandidates, saveSettings, controlTask, deleteTask };
});

export function humanError(value: string): string {
  const labels: Record<string, string> = {
    app_session_not_found: "此流萤页面的会话已经失效，请从来源网页重新打开。",
    native_host_unavailable: "未连接到本地助手，请安装或重新启动流萤本地助手。",
    native_host_timeout: "本地助手响应超时，请重启后重试。",
    hls_selection_native_upgrade_required: "本地助手版本过旧，请安装 0.9.0 Beta 2 后重试。",
    inline_hls_native_upgrade_required: "本地助手版本过旧，请安装 0.9.0 Beta 2 后重试。",
    hls_plan_expired: "本地助手重启后无法恢复该 HLS 选择计划，请从资源页重新解析并创建任务。",
    hls_authorization_required: "请回到仍保持登录的来源页面，重新播放资源后再授权继续。",
    hls_key_required: "请重新输入 AES-128 密钥后继续。",
    hls_source_candidate_missing: "当前流萤页面已找不到原资源，请回到来源网页重新播放并嗅探。",
    hls_key_override_invalid: "自定义 AES-128 密钥或 IV 格式无效。",
    hls_key_validation_failed: "AES-128 密钥未能解开首个媒体切片，请检查密钥和 IV。",
    hls_map_iv_required: "该 HLS 的加密初始化片段缺少规范要求的显式 IV。",
    hls_encryption_unsupported: "该 HLS 使用了暂不支持的加密方式；流萤不会绕过 DRM。",
    hls_checkpoint_invalid: "HLS 检查点已损坏，请重新创建下载任务。",
    hls_checkpoint_version_unsupported: "HLS 检查点版本不兼容，请升级本地助手或重新创建任务。",
    hls_live_not_supported: "Beta 2 暂不支持直播 M3U8 下载。",
    path_not_writable: "保存目录不可写，请检查路径和权限。",
    source_page_closed: "来源页面已经关闭。"
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
