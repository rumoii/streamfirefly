import type { DownloadTask, TaskOutput } from "./types";

const imageExtensions = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const audioExtensions = new Set(["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "weba", "wma"]);
const videoExtensions = new Set(["3gp", "asf", "avi", "f4v", "flv", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "ogv", "webm", "wmv"]);

function outputExtension(output: TaskOutput): string {
  const name = output.path?.split(/[\\/]/).at(-1) || "";
  return name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "";
}

export function taskOutputLabel(task: DownloadTask, output: TaskOutput): string {
  if (output.kind === "subtitle") return output.language || output.label || "字幕";
  const mime = String(task.mime || "").toLowerCase();
  if (mime.startsWith("image/")) return "图片";
  if (mime.startsWith("audio/")) return "音频";
  if (mime.startsWith("video/") || task.hls_selection || task.dash_selection || task.hls_plan_version) return "视频";
  const extension = outputExtension(output);
  if (imageExtensions.has(extension)) return "图片";
  if (audioExtensions.has(extension)) return "音频";
  if (videoExtensions.has(extension)) return "视频";
  return "媒体";
}
