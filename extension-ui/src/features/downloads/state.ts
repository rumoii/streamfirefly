import { computed, type Ref } from "vue";
import { sendCore, sendMessage } from "../../api";
import { createTaskState } from "../../task-state";
import type { DownloadTask, MediaCandidate } from "../../types";
export function createDownloadsState(candidates: Ref<MediaCandidate[]>) {
  const taskState = createTaskState(message => message.type === "native.connect" ? sendCore({ type: "native.connect" }) : sendCore({ type: "task.list" }));
  const activeTasks = computed(() => taskState.tasks.value.filter(task => ["queued", "starting", "running", "retrying", "pausing", "cancelling", "stopping"].includes(task.state)));
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
    if (result.task) taskState.receive({ type: "task.progress", task: result.task });
  }

  async function deleteTask(task: DownloadTask, deleteFile: boolean) {
    const result: any = await sendMessage({ type: "task.delete", payload: { id: task.id, deleteFile } });
    if (!result?.ok) throw new Error(result?.error || "task_delete_failed");
    taskState.receive({ type: "task.deleted", id: task.id });
  }

  return { ...taskState, activeTasks, controlTask, deleteTask };
}
