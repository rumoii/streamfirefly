import { ref } from "vue";
import type { DownloadTask } from "./types";

export type ConnectionState = "connecting" | "ready" | "disconnected" | "missing" | "timeout" | "incompatible" | "error";
export interface HostResponse { ok: boolean; error?: string; tasks?: DownloadTask[]; capabilities?: string[] }
export type HostRequest = (message: { type: "native.connect" | "task.list" }) => Promise<HostResponse>;

export function createTaskState(request: HostRequest) {
  const tasks = ref<DownloadTask[]>([]);
  const capabilities = ref<string[]>([]);
  const connection = ref<ConnectionState>("connecting");
  const connectionError = ref("");
  let inFlight: Promise<void> | null = null;
  let revision = 0;
  let disposed = false;
  let connectionEpoch = 0;
  let resyncTimer: ReturnType<typeof setTimeout> | null = null;

  function receive(message: { type: string; id?: string; task?: DownloadTask; error?: string }) {
    if (disposed) return;
    if (message.type === "native.disconnected" || message.type === "task.persistence-error") { connectionEpoch++; fail(message.error || "native_host_disconnected"); return; }
    if (message.type === "task.deleted" && message.id) { revision++; tasks.value = tasks.value.filter(task => task.id !== message.id); }
    if (message.type === "task.progress" && message.task) {
      revision++;
      const index = tasks.value.findIndex(task => task.id === message.task!.id);
      if (index < 0) tasks.value.push(message.task);
      else if ((message.task.revision ?? 0) >= (tasks.value[index].revision ?? 0)) tasks.value[index] = message.task;
    }
  }

  function fail(error: string) {
    connectionError.value = error;
    connection.value = error.startsWith("task_store_") || error === "native_host_invalid_response" ? "error" : error === "native_host_missing" ? "missing" : error === "native_host_incompatible" ? "incompatible" : error === "native_host_timeout" ? "timeout" : "disconnected";
  }

  async function synchronize() {
    const epoch = connectionEpoch;
    try {
      if (connection.value !== "ready") {
        connection.value = "connecting";
        const info = await request({ type: "native.connect" });
        if (disposed || epoch !== connectionEpoch) return;
        if (!info.ok) throw new Error(info.error || "native_host_disconnected");
        capabilities.value = info.capabilities || [];
      }
      const before = revision;
      const result = await request({ type: "task.list" });
      if (disposed || epoch !== connectionEpoch) return;
      if (!result.ok || !Array.isArray(result.tasks)) throw new Error(result.error || "native_host_invalid_response");
      if (revision === before) tasks.value = result.tasks;
      else if (resyncTimer == null) resyncTimer = setTimeout(() => { resyncTimer = null; void refresh(); }, 100);
      connection.value = "ready";
      connectionError.value = "";
    } catch (error) { if (!disposed && epoch === connectionEpoch) fail(error instanceof Error ? error.message : "native_host_disconnected"); }
  }

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (!inFlight) inFlight = synchronize().finally(() => { inFlight = null; });
    return inFlight;
  }
  function dispose() { disposed = true; revision++; if (resyncTimer != null) clearTimeout(resyncTimer); }
  return { tasks, capabilities, connection, connectionError, refresh, receive, dispose };
}
