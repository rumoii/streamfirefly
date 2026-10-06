import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { UiContext } from "../../types";
import type { CaptureSnapshot, CaptureSources } from "../../../../shared/capture";
import { sessionError, sessionRequest } from "../session-client";
import { isBlobCandidate } from "../../media";
import type { MediaCandidate } from "../../types";
export function createCaptureState(context: Ref<UiContext | null>, trusted: boolean, targetObjectUrl?: Ref<string | undefined>) {
  const sessions = ref<CaptureSnapshot[]>([]), catalog = ref<CaptureSources>({ sources: [], frames: [] });
  const error = ref(""), message = ref(""), busy = ref(false), selected = ref(""), acknowledged = ref(false), directory = ref("");
  let revision = 0, disposed = false, refreshing = false;
  let connectionFailure = "";
  const restarting = ref(false), renewed = ref(false), restartPhase = ref("");
  let restartOperation = "", restartContext = "", restartTab = -1;
  const quickCandidate = computed<MediaCandidate | undefined>(() => {
    const downloadable = (context.value?.candidates || []).filter(item => !isBlobCandidate(item) && ["hls", "dash", "video", "audio"].includes(item.type));
    return downloadable.find(item => item.type !== "audio") || downloadable[0];
  });
  const quickDownloadAvailable = computed(() => Boolean(quickCandidate.value));
  const orderedSessions = computed(() => [...sessions.value].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
  const finishedStates = ["complete", "partial", "interrupted"];
  const failedSessions = computed(() => sessions.value.filter(session => ["partial", "interrupted"].includes(session.state)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sourceKey = (source: CaptureSources["sources"][number]) => `${source.frameId}:${source.documentToken}:${source.id}`;
  const active = computed(() => sessions.value.find(session => session.tabId === context.value?.sourceTabId && ["armed", "capturing", "stopping", "finalizing"].includes(session.state)));
  const lastSessionId = ref("");
  const lastSession = computed(() => lastSessionId.value ? sessions.value.find(session => session.id === lastSessionId.value) : undefined);
  const phase = computed(() => active.value ? (["stopping", "finalizing"].includes(active.value.state) ? "saving" : "recording") : restarting.value ? "waiting" : lastSession.value?.state === "complete" ? "done" : lastSession.value && ["partial", "interrupted"].includes(lastSession.value.state) ? "failed" : "ready");
  const selectionLocked = computed(() => Boolean(!renewed.value && targetObjectUrl?.value && catalog.value.sources.length === 1 && catalog.value.sources[0].objectUrls.includes(targetObjectUrl.value)));
  const blobUnconfirmed = computed(() => {
    const objectUrl = targetObjectUrl?.value;
    return Boolean(objectUrl && catalog.value.sources.length && !catalog.value.sources.some(source => source.objectUrls.includes(objectUrl)));
  });
  async function refresh() {
    if (!trusted || disposed || refreshing) return;
    refreshing = true; clearTimeout(timer);
    try {
      const result = await sessionRequest("capture.list", undefined);
      if (!disposed) { sessions.value = result; if (error.value === connectionFailure) error.value = ""; connectionFailure = ""; }
      if (!disposed && restarting.value && restartOperation) {
        // A lapsed restart is a final outcome, so its error must outlive the next successful list refresh.
        const status = await sessionRequest("capture.restart.status", { tabId: restartTab, operationId: restartOperation }).catch(reason => {
          if (!disposed) { restarting.value = false; restartOperation = ""; restartPhase.value = ""; acknowledged.value = false; error.value = sessionError(reason); }
          return null;
        });
        if (status && !disposed) restartPhase.value = status.phase;
        if (status && !disposed && restarting.value && status.phase === "claimed" && status.sourceContextId && status.sources.length) {
          restartContext = status.sourceContextId; catalog.value = status; renewed.value = true; restarting.value = false;
          selected.value = status.sources.length === 1 ? sourceKey(status.sources[0]) : "";
          message.value = status.sources.length === 1 ? "已开始录制。让视频播放到结尾，播完会自动保存；也可以随时点“停止并保存”。" : "页面上有多个视频，请在“高级选项”里选择要录制的那个，再点“开始捕捉”。";
          if (status.sources.length === 1) { acknowledged.value = true; await start(true); }
        }
      }
    }
    catch (reason) { if (!disposed) { connectionFailure = sessionError(reason); error.value = connectionFailure; restarting.value = false; } }
    finally { refreshing = false; if (!disposed) timer = setTimeout(() => void refresh(), 1500); }
  }
  async function scan() {
    if (!trusted || disposed || !context.value?.supported || busy.value || active.value) return;
    const current = ++revision; busy.value = true; error.value = "";
    try {
      const result = await sessionRequest("capture.sources", { tabId: context.value.sourceTabId });
      if (current !== revision || disposed) return;
      const objectUrl = renewed.value ? "" : targetObjectUrl?.value || "";
      const matches = objectUrl ? result.sources.filter(source => source.objectUrls.includes(objectUrl)) : [];
      const sources = matches.length ? matches : result.sources;
      catalog.value = { ...result, sources };
      selected.value = (objectUrl ? matches.length === 1 : sources.length === 1) ? sourceKey(sources[0]) : "";
      acknowledged.value = false;
      if (objectUrl) {
        message.value = matches.length === 1 ? "已定位此 Blob 对应的媒体源。请确认授权后开始捕捉。" : matches.length > 1 ? `此 Blob 对应 ${matches.length} 个媒体源，请选择要捕捉的一项。` : sources.length ? "请选择候选媒体源，并确认将捕捉所选媒体。" : "";
        error.value = sources.length ? "" : sessionError("capture_blob_source_unavailable");
      } else {
        message.value = sources.length ? `发现 ${sources.length} 个媒体源，请确认框架和媒体类型。` : "未发现可捕捉媒体源；请先播放视频，或刷新来源页面后重试。";
      }
    }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function start(fromRefresh = false) {
    const source = catalog.value.sources.find(item => sourceKey(item) === selected.value);
    if (!source || !context.value || !acknowledged.value || busy.value) return;
    const current = revision; busy.value = true; error.value = "";
    const objectUrl = renewed.value ? "" : targetObjectUrl?.value;
    try { const opened = await sessionRequest("capture.open", { tabId: context.value.sourceTabId, sourceContextId: restartContext || context.value.sourceContextId, source, directory: directory.value, objectUrl: objectUrl && source.objectUrls.includes(objectUrl) ? objectUrl : undefined, restartOperation: restartOperation || undefined }); lastSessionId.value = opened.id; restartOperation = ""; if (current === revision && !disposed) message.value = "捕捉已启动，等待媒体数据追加；无新增数据时请使用重新捕捉。"; if (!fromRefresh) await refresh(); }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function restart() {
    if (!context.value || !acknowledged.value || busy.value || restarting.value) return;
    busy.value = true; error.value = "";
    try {
      const response = await sessionRequest("capture.restart", { tabId: context.value.sourceTabId, sourceContextId: restartContext || context.value.sourceContextId });
      restartOperation = response.operationId; restartTab = context.value.sourceTabId; restarting.value = true; lastSessionId.value = ""; restartPhase.value = "waiting"; renewed.value = true; catalog.value = { sources: [], frames: [] }; selected.value = "";
      message.value = "";
    } catch (reason) { error.value = sessionError(reason); }
    finally { busy.value = false; }
  }
  async function replay() {
    if (!context.value || !active.value || busy.value) return;
    busy.value = true; error.value = "";
    try { await sessionRequest("capture.replay", { tabId: context.value.sourceTabId, id: active.value.id }); message.value = "已从头播放所选视频；重播不一定会追加新数据，无新增数据时请使用重新捕捉。"; }
    catch (reason) { error.value = sessionError(reason); }
    finally { busy.value = false; }
  }
  async function stop() {
    if (!active.value || busy.value || !context.value) return;
    const current = revision; busy.value = true; error.value = ""; message.value = "正在停止并等待落盘确认，尚未完成保存。";
    try { await sessionRequest("capture.close", { tabId: context.value.sourceTabId, id: active.value.id }); if (current === revision && !disposed) message.value = "停止请求已处理，请等待会话显示已保存或部分结果。"; await refresh(); }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function remove(id: string) {
    if (busy.value) return;
    busy.value = true; error.value = "";
    try { await sessionRequest("capture.delete", { id }); await refresh(); }
    catch (reason) { if (!disposed) error.value = sessionError(reason); }
    finally { if (!disposed) busy.value = false; }
  }
  async function removeFailed() {
    if (busy.value) return;
    busy.value = true; error.value = "";
    const failures: string[] = [];
    for (const session of failedSessions.value.filter(item => finishedStates.includes(item.state))) {
      try { await sessionRequest("capture.delete", { id: session.id }); }
      catch (reason) { failures.push(sessionError(reason)); }
    }
    try { await refresh(); } finally { if (!disposed) { busy.value = false; if (failures.length) error.value = `有 ${failures.length} 条记录未能删除：${failures[0]}`; } }
  }
  async function recover(id: string) {
    if (busy.value) return;
    busy.value = true;
    try { await sessionRequest("capture.recover", { id }); await refresh(); }
    catch (reason) { if (!disposed) error.value = sessionError(reason); }
    finally { if (!disposed) busy.value = false; }
  }
  watch([() => context.value?.sourceContextId, () => targetObjectUrl?.value || ""], () => {
    revision++; catalog.value = { sources: [], frames: [] }; selected.value = ""; acknowledged.value = false; busy.value = false; error.value = ""; message.value = "";
    if (context.value?.supported && targetObjectUrl?.value) void scan();
  }, { immediate: true });
  watch(selected, () => { acknowledged.value = false; });
  onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer); });
  void refresh();
  return { lastSession, restartPhase, sessions, orderedSessions, failedSessions, phase, quickCandidate, remove, removeFailed, catalog, error, message, busy, selected, acknowledged, directory, active, selectionLocked, blobUnconfirmed, sourceKey, scan, start, stop, recover, refresh, restarting, renewed, quickDownloadAvailable, restart, replay };
}
