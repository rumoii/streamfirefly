import { formatBytes, formatDuration, formatSpeed } from "../../format";
import type { DownloadTask } from "../../types";
import type { IconName } from "../../ui/icons";

export type TaskActionKey = "stop" | "pause" | "resume" | "retry" | "cancel" | "delete";
export type TaskAction = { key: TaskActionKey; label: string; icon: IconName; danger?: boolean };

const activeStates = new Set(["queued", "starting", "running", "retrying", "pausing", "cancelling", "stopping"]);
const workingStates = new Set(["starting", "running", "retrying", "pausing", "cancelling", "stopping"]);

export function isActive(task: DownloadTask) { return activeStates.has(task.state); }
export function isRecording(task: DownloadTask) { return Boolean(task.live_recording) && isActive(task); }
export function isWorking(task: DownloadTask) { return workingStates.has(task.state); }

export function stateLabel(task: DownloadTask) {
  const labels: Record<string, string> = { queued: "等待下载", starting: task.phase === "validating_key" ? "正在验证密钥" : "正在连接", running: task.phase === "recording" ? "正在录制直播" : task.phase === "downloading_segments" ? "正在下载切片" : task.phase === "fetching" ? "读取清单" : task.phase === "merging" ? "正在无转码合并" : "正在下载", retrying: "正在恢复", pausing: "正在暂停", paused: "已暂停", cancelling: "正在取消", stopping: "正在停止并保存", cancelled: "已取消", succeeded: "已完成", failed: "下载失败", partial: "部分输出失败", interrupted: task.resume_requirement ? "等待用户恢复" : "已中断" };
  return labels[task.state] || task.message || task.state;
}

export function stateIcon(task: DownloadTask): IconName {
  if (isRecording(task)) return "broadcast";
  if (task.state === "queued") return "clock";
  if (isWorking(task)) return "loader-2";
  const icons: Record<string, IconName> = { paused: "player-pause", succeeded: "circle-check", failed: "alert-triangle", partial: "alert-triangle", cancelled: "circle-x", interrupted: "arrow-back-up" };
  return icons[task.state] || "download";
}

export function progressText(task: DownloadTask) { return isRecording(task) ? "LIVE" : `${task.progress || 0}%`; }

export function recordedText(seconds: number) { return `已录制 ${Math.floor(seconds / 60)}分${Math.floor(seconds % 60)}秒`; }

export function statusLine(task: DownloadTask) {
  const parts = [stateLabel(task)];
  if (isRecording(task)) {
    if (task.recorded_duration) parts.push(recordedText(task.recorded_duration));
  } else if (isActive(task) || task.state === "paused") {
    if (isWorking(task)) parts.push(formatSpeed(task.speed_bytes_per_second));
    if (task.downloaded_bytes) parts.push(task.total_bytes ? `${formatBytes(task.downloaded_bytes)} / ${formatBytes(task.total_bytes)}` : formatBytes(task.downloaded_bytes));
    if (isWorking(task) && task.eta_seconds != null) parts.push(`剩余 ${formatDuration(task.eta_seconds)}`);
  } else if (["failed", "partial"].includes(task.state) && task.message) parts.push(task.message);
  return parts.join(" · ");
}

export function resumeLabel(task: DownloadTask) {
  if (task.resume_requirement?.includes("authorization") && task.resume_requirement.includes("key")) return "重新授权、输入密钥并继续";
  return task.resume_requirement?.includes("authorization") ? "重新授权并继续" : task.resume_requirement?.includes("key") ? "输入密钥并继续" : "继续";
}

export function resumeNotice(task: DownloadTask) {
  if (task.resume_requirement === "dash_reparse_required") return "请回到资源页重新解析 DASH 并创建任务";
  if (task.resume_requirement?.includes("authorization") && task.resume_requirement.includes("key")) return "需要来源页面重新授权并重新输入自定义密钥";
  return task.resume_requirement?.includes("authorization") ? "需要来源页面重新授权" : "需要重新输入自定义密钥";
}

/** Splits the available controls into one inline action and the overflow menu, in display order. */
export function taskActions(task: DownloadTask): { primary: TaskAction | null; menu: TaskAction[] } {
  const available: TaskAction[] = [];
  if (task.live_recording && ["queued", "starting", "running", "retrying", "paused", "interrupted"].includes(task.state)) available.push({ key: "stop", label: "停止并保存", icon: "player-stop" });
  if (task.resume_requirement !== "dash_reparse_required" && (task.state === "paused" || (task.state === "interrupted" && Boolean(task.resume_requirement)))) available.push({ key: "resume", label: resumeLabel(task), icon: task.resume_requirement?.includes("key") ? "key" : "player-play" });
  if (isActive(task) && !["pausing", "stopping", "cancelling"].includes(task.state)) available.push({ key: "pause", label: "暂停", icon: "player-pause" });
  if (["failed", "cancelled", "interrupted", "partial"].includes(task.state) && !task.resume_requirement) available.push({ key: "retry", label: "重试", icon: "refresh" });
  // Matches the states the native host accepts for cancellation.
  if (["queued", "starting", "running", "retrying", "pausing", "paused"].includes(task.state)) available.push({ key: "cancel", label: "取消", icon: "x" });
  const primary = available.find(action => action.key !== "cancel") || null;
  return { primary, menu: [...available.filter(action => action !== primary), { key: "delete", label: "删除任务…", icon: "trash", danger: true }] };
}
