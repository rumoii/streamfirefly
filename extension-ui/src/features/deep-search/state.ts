import { onBeforeUnmount, ref, watch, type InjectionKey, type Ref } from "vue";
import type { UiContext } from "../../types";
import type { DeepSearchStatus } from "../../../../shared/capture";
import { sessionError, sessionRequest } from "../session-client";
export type DeepSearchState = ReturnType<typeof createDeepSearchState>;
// Shared by the toolbar button and the resource-list hint so both see one status and one dialog.
export const deepSearchKey: InjectionKey<DeepSearchState> = Symbol("deep-search");
export function createDeepSearchState(context: Ref<UiContext | null>) {
  const state = ref<DeepSearchStatus>({ enabled: false, siteRemembered: false, requiresReload: false, keys: [], frames: [] });
  const remember = ref(false), busy = ref(false), message = ref(""), hasError = ref(false), dialogOpen = ref(false);
  let revision = 0, disposed = false;
  async function refresh() {
    if (busy.value) return;
    const current = ++revision;
    if (!context.value?.supported) return;
    try { const result = await sessionRequest("deep.status", { tabId: context.value.sourceTabId }); if (current !== revision || disposed) return; state.value = result; remember.value = result.siteRemembered; message.value = ""; hasError.value = false; }
    catch (error) { if (current === revision && !disposed) { message.value = sessionError(error); hasError.value = true; } }
  }
  async function toggle() {
    if (!context.value?.supported || busy.value) return;
    const current = ++revision; busy.value = true;
    try { const result = await sessionRequest("deep.set", { tabId: context.value.sourceTabId, enabled: !state.value.enabled, remember: remember.value }); if (current !== revision || disposed) return; state.value = result; remember.value = result.siteRemembered; hasError.value = false; message.value = result.enabled ? "已开启，请检查各框架的运行结果。" : "已关闭，当前会话密钥候选已清理。"; }
    catch (error) { if (current === revision && !disposed) { message.value = sessionError(error); hasError.value = true; } }
    finally { if (current === revision && !disposed) busy.value = false; }
  }
  watch(() => context.value?.sourceContextId, () => { busy.value = false; message.value = ""; hasError.value = false; state.value = { enabled: false, siteRemembered: false, requiresReload: false, keys: [], frames: [] }; void refresh(); }, { immediate: true });
  onBeforeUnmount(() => { disposed = true; revision++; });
  return { state, remember, busy, message, hasError, dialogOpen, refresh, toggle };
}
