import { sendMessage } from "../api";
import type { CaptureRequests } from "../../../shared/capture";
export async function sessionRequest<Type extends keyof CaptureRequests>(type: Type, payload: CaptureRequests[Type]["payload"]): Promise<CaptureRequests[Type]["value"]> {
  const result = await sendMessage<{ ok: boolean; value?: CaptureRequests[Type]["value"]; error?: string }>({ type, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
  if (!result?.ok) throw new Error(result?.error || "capture_host_disconnected");
  const value = result.value;
  if ((type === "capture.list" && !Array.isArray(value)) || ((type === "deep.status" || type === "deep.set") && (!value || !Array.isArray((value as CaptureRequests["deep.status"]["value"]).frames))) || (type === "capture.sources" && (!value || !Array.isArray((value as CaptureRequests["capture.sources"]["value"]).sources)))) throw new Error("助手或扩展返回了无效会话状态，请刷新并确认组件版本一致。");
  return result.value as CaptureRequests[Type]["value"];
}
const messages: Record<string, string> = {
  capture_source_required: "请先扫描并选择一个媒体源。",
  capture_source_unavailable: "所选媒体源已消失，已保留落盘片段；请重新扫描来源。",
  capture_blob_source_unavailable: "未找到此 Blob 对应的媒体源。请刷新来源页、开始播放视频，再重新打开缓存捕捉。",
  capture_object_url_invalid: "Blob 媒体地址无效，请从资源列表重新打开缓存捕捉。",
  capture_document_changed: "来源页面或框架已变化，请重新扫描后开启。",
  capture_document_unavailable: "无法访问此框架，请检查权限或刷新来源页面。",
  capture_probe_unavailable: "此框架的媒体探针未就绪，请刷新来源页面；受限页面不支持捕捉。",
  capture_already_open: "此页面已有捕捉会话，请先停止当前会话。",
  capture_host_disconnected: "本地助手不可用，请检查安装与连接；已有片段不会自动删除。",
  native_host_disconnected: "本地助手已断开，请检查连接后刷新会话。",
  capture_disconnected: "捕捉连接中断，已落盘片段可尝试整理。",
  capture_backpressure: "写入速度不足，捕捉已停止；请检查磁盘并整理已有片段。",
  capture_drain_timeout: "等待片段落盘确认超时，不能视为完整保存。",
  capture_drm_unsupported: "不支持 DRM 媒体捕捉。",
  capture_session_changed: "当前会话已变化，请刷新后操作。",
  capture_cleanup_failed: "部分清理操作未获确认，请检查助手和会话状态。",
  capture_worker_stopping: "捕捉线程正在退出，请稍后再次整理片段。"
};
export function sessionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "操作失败");
  return messages[message] || message;
}
