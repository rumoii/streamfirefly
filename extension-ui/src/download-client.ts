import { sendMessage } from "./api";
import type { DownloadTask, MediaCandidate } from "./types";
import { prepareDefaultDownload } from "./download-plan";

export async function prepareCandidate(candidate: MediaCandidate, tabId: number | null) {
  return prepareDefaultDownload(candidate, async url => {
    const result = await sendMessage({ type: "media.fetchText", tabId, id: candidate.id, url });
    if (!result?.ok) throw new Error(result?.error || "media_fetch_failed");
    return { text: result.text as string, url: (result.url || url) as string };
  });
}

export async function createDownload(payload: Record<string, unknown>, requestId: string): Promise<DownloadTask> {
  let result = await sendMessage({ type: "task.create", payload: { ...payload, requestId } });
  if (!result?.ok && ["native_host_timeout", "native_host_disconnected"].includes(result?.error)) {
    const found = await sendMessage({ type: "task.find", payload: { requestId } });
    if (!found?.ok) throw new Error("提交结果尚未确认，请恢复连接后重试；相同请求不会重复创建。");
    result = found.task ? found : await sendMessage({ type: "task.create", payload: { ...payload, requestId } });
  }
  if (!result?.ok) throw new Error(result?.error || "task_create_failed");
  return result.task;
}
