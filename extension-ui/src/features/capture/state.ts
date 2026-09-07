import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { UiContext } from "../../types";
import type { CaptureSnapshot, CaptureSources } from "../../../../shared/capture";
import { sessionError, sessionRequest } from "../session-client";
export function createCaptureState(context: Ref<UiContext | null>, trusted: boolean) {
  const sessions = ref<CaptureSnapshot[]>([]), catalog = ref<CaptureSources>({ sources: [], frames: [] });
  const error = ref(""), message = ref(""), busy = ref(false), selected = ref(""), acknowledged = ref(false), directory = ref("");
  let revision = 0, disposed = false, refreshing = false;
  let connectionFailure = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sourceKey = (source: CaptureSources["sources"][number]) => `${source.frameId}:${source.documentToken}:${source.id}`;
  const active = computed(() => sessions.value.find(session => session.tabId === context.value?.sourceTabId && ["armed", "capturing", "stopping", "finalizing"].includes(session.state)));
  async function refresh() {
    if (!trusted || disposed || refreshing) return;
    refreshing = true; clearTimeout(timer);
    try { const result = await sessionRequest("capture.list", undefined); if (!disposed) { sessions.value = result; if (error.value === connectionFailure) error.value = ""; connectionFailure = ""; } }
    catch (reason) { if (!disposed) { connectionFailure = sessionError(reason); error.value = connectionFailure; } }
    finally { refreshing = false; if (!disposed) timer = setTimeout(() => void refresh(), 1500); }
  }
  async function scan() {
    if (!context.value?.supported) return;
    const current = ++revision; busy.value = true; error.value = "";
    try { const result = await sessionRequest("capture.sources", { tabId: context.value.sourceTabId }); if (current !== revision || disposed) return; catalog.value = result; selected.value = result.sources.length === 1 ? sourceKey(result.sources[0]) : ""; message.value = result.sources.length ? `发现 ${result.sources.length} 个媒体源，请确认框架和媒体类型。` : "未发现可捕捉媒体源；请先播放视频，或刷新来源页面后重试。"; }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function start() {
    const source = catalog.value.sources.find(item => sourceKey(item) === selected.value);
    if (!source || !context.value || !acknowledged.value || busy.value) return;
    const current = revision; busy.value = true; error.value = "";
    try { await sessionRequest("capture.open", { tabId: context.value.sourceTabId, sourceContextId: context.value.sourceContextId, source, directory: directory.value }); if (current === revision && !disposed) message.value = "捕捉已启动，等待所选媒体源追加数据；开始前的缓存不会回溯。"; await refresh(); }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function stop() {
    if (!active.value || busy.value || !context.value) return;
    const current = revision; busy.value = true; error.value = ""; message.value = "正在停止并等待落盘确认，尚未完成保存。";
    try { await sessionRequest("capture.close", { tabId: context.value.sourceTabId, id: active.value.id }); if (current === revision && !disposed) message.value = "停止请求已处理，请等待会话显示已保存或部分结果。"; await refresh(); }
    catch (reason) { if (current === revision && !disposed) error.value = sessionError(reason); }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  async function recover(id: string) {
    if (busy.value) return;
    busy.value = true;
    try { await sessionRequest("capture.recover", { id }); await refresh(); }
    catch (reason) { if (!disposed) error.value = sessionError(reason); }
    finally { if (!disposed) busy.value = false; }
  }
  watch(() => context.value?.sourceContextId, () => { revision++; catalog.value = { sources: [], frames: [] }; selected.value = ""; acknowledged.value = false; busy.value = false; error.value = ""; message.value = ""; }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer); });
  void refresh();
  return { sessions, catalog, error, message, busy, selected, acknowledged, directory, active, sourceKey, scan, start, stop, recover, refresh };
}
