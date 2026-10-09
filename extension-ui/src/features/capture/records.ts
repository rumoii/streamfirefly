import { onBeforeUnmount, ref, watch, type Ref } from "vue";
import type { CaptureSnapshot } from "../../../../shared/capture";
import { sessionError, sessionRequest } from "../session-client";

const POLL_MS = 1500;

/** Recording history for the downloads page, refreshed every 1.5 s while visible like the capture control page. */
export function useCaptureRecords(active: Ref<boolean>) {
  const sessions = ref<CaptureSnapshot[]>([]);
  const loaded = ref(false), busy = ref(false), error = ref("");
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, revision = 0;

  async function refresh() {
    clearTimeout(timer);
    const current = ++revision;
    try { const result = await sessionRequest("capture.list", undefined); if (!disposed && current === revision) { sessions.value = result; loaded.value = true; error.value = ""; } }
    catch (reason) { if (!disposed && current === revision) error.value = sessionError(reason); }
    finally { if (!disposed && current === revision && active.value) timer = setTimeout(() => void refresh(), POLL_MS); }
  }
  // The record itself shows "正在生成文件" while a recovery runs, so no separate progress message is kept.
  async function run(action: () => Promise<unknown>) {
    if (busy.value) return;
    busy.value = true; error.value = "";
    try { await action(); await refresh(); }
    catch (reason) { if (!disposed) error.value = sessionError(reason); }
    finally { if (!disposed) busy.value = false; }
  }
  const remove = (id: string) => run(() => sessionRequest("capture.delete", { id }));
  const recover = (id: string) => run(() => sessionRequest("capture.recover", { id }));
  async function removeFailed() {
    const failures: string[] = [];
    await run(async () => {
      for (const session of sessions.value.filter(item => ["partial", "interrupted"].includes(item.state))) {
        try { await sessionRequest("capture.delete", { id: session.id }); } catch (reason) { failures.push(sessionError(reason)); }
      }
    });
    if (failures.length && !disposed) error.value = `${failures.length} 条记录没有删除：${failures[0]}`;
  }

  // One load gives the tab its count; polling continues only while the list is shown.
  watch(active, visible => { clearTimeout(timer); if (visible) void refresh(); });
  void refresh();
  onBeforeUnmount(() => { disposed = true; clearTimeout(timer); });
  return { sessions, loaded, busy, error, refresh, remove, recover, removeFailed };
}
