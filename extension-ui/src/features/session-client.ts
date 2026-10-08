import { sendMessage } from "../api";
import type { CaptureRequests } from "../../../shared/capture";
export async function sessionRequest<Type extends keyof CaptureRequests>(type: Type, payload: CaptureRequests[Type]["payload"]): Promise<CaptureRequests[Type]["value"]> {
  const result = await sendMessage<{ ok: boolean; value?: CaptureRequests[Type]["value"]; error?: string }>({ type, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
  if (!result) throw new Error("extension_no_response");
  if (!result.ok) throw new Error(result.error || "capture_host_disconnected");
  const value = result.value;
  if ((type === "capture.list" && !Array.isArray(value)) || ((type === "deep.status" || type === "deep.set") && (!value || !Array.isArray((value as CaptureRequests["deep.status"]["value"]).frames))) || (type === "capture.sources" && (!value || !Array.isArray((value as CaptureRequests["capture.sources"]["value"]).sources)))) throw new Error("助手或扩展返回了无效会话状态，请刷新并确认组件版本一致。");
  return result.value as CaptureRequests[Type]["value"];
}
const messages: Record<string, string> = {
  capture_no_media_data: "录制期间视频没有加载新内容，通常是视频在开始前已经缓冲完了。请点“一键捕捉”重新录制。",
  capture_initialization_missing: "录到的内容缺少视频开头信息，无法生成可播放文件。请点“一键捕捉”重新录制。",
  capture_initialization_limit: "视频开头信息过大，无法补全。请点“一键捕捉”重新录制。",
  capture_merge_failed: "生成视频文件失败，原始数据已保留。可以点“重新生成文件”再试一次，或删除后重新录制。",
  capture_restart_timeout: "等待超时：来源页加载太久，或者 2 分钟内没有开始播放。请重新勾选授权后再点“一键捕捉”。",
  capture_restart_storage_unavailable: "这个网站不允许保存录制标记，无法使用一键捕捉。",
  capture_speed_unavailable: "没能调整播放速度，请回到来源页确认视频正在播放。",
  capture_speed_invalid: "不支持这个录制速度。",
  capture_speed_overridden: "网站把播放速度改回去了，录制会按网站的速度继续，内容不受影响。",
  capture_video_unavailable: "没能确定要从头播放的是哪个视频，请回到来源页手动播放。",
  capture_source_required: "请先在“高级选项”里选择要录制的视频。",
  capture_source_unavailable: "所选视频已经不在页面上了，已录到的内容会保留。请重新扫描后再试。",
  capture_blob_source_unavailable: "未发现可捕捉媒体源。请点“一键捕捉”，来源页刷新后播放视频。",
  capture_object_url_invalid: "这条临时视频地址无效，请从资源列表重新打开缓存捕捉。",
  capture_document_changed: "来源页已经变化（刷新或跳转了），请重新开始。",
  capture_document_unavailable: "无法访问这个页面框架，请刷新来源页后重试。",
  capture_probe_unavailable: "录制功能在这个页面还没就绪，请刷新来源页；部分受限页面不支持录制。",
  capture_already_open: "这个页面正在录制，请先停止当前录制。",
  capture_host_disconnected: "本地下载助手没有连接，请先安装或启动它；已录到的内容不会被删除。",
  native_host_disconnected: "本地下载助手连接断开了，请检查后点“刷新会话”。",
  capture_disconnected: "录制连接中断了，已录到的内容可以点“重新生成文件”尝试保存。",
  capture_ack_timeout: "本地下载助手 30 秒内没有确认写入，录制已停止。已录到的内容可以点“重新生成文件”尝试保存。",
  capture_ack_invalid: "本地下载助手的写入确认对不上，录制已停止。已录到的内容可以点“重新生成文件”尝试保存。",
  capture_sender_invalid: "录制通道已经关闭，后续数据没能送达，录制已停止。已录到的内容可以点“重新生成文件”尝试保存。",
  capture_backpressure: "数据来得太快，写入跟不上，录制已停止。可以点“重新生成文件”保存已录到的部分。",
  capture_drain_timeout: "保存时等待太久，文件可能不完整。",
  capture_drm_unsupported: "这个视频有版权保护（DRM），无法录制。",
  capture_session_changed: "录制状态已经变化，请点“刷新会话”后再操作。",
  capture_cleanup_failed: "部分清理没有完成，请检查本地下载助手后重试。",
  capture_worker_stopping: "上一次处理还没结束，请稍等几秒再试。",
  capture_host_restarted: "录制过程中本地下载助手重启了，已录到的内容可以点“重新生成文件”尝试保存。",
  capture_host_stopped: "录制过程中本地下载助手被关闭了，已录到的内容可以点“重新生成文件”尝试保存。",
  capture_delete_active: "正在录制或处理中的记录不能删除，请先停止。",
  capture_delete_failed: "删除失败，文件可能正被其他程序占用。",
  capture_not_found: "这条记录已经不存在了。",
  extension_no_response: "扩展后台没有响应。请到扩展管理页点流萤的“重新加载”，再刷新本页重试。"
};
export function sessionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "操作失败");
  return messages[message] || message;
}
