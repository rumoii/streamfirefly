export function formatBytes(value?: number | null): string {
  if (!Number.isFinite(value)) return "大小未知";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Number(value);
  let index = 0;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index += 1; }
  return `${size >= 10 || index === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

export function formatDuration(value?: number | null): string {
  if (!Number.isFinite(value)) return "时长未知";
  const seconds = Math.max(0, Math.round(Number(value)));
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatSpeed(value?: number | null): string { return Number(value) > 0 ? `${formatBytes(value)}/s` : "等待测速"; }

/** Page-probe sources are composed (`xhr-json`, `fetch-body-member`, ...), so they are matched by prefix and suffix. */
export function sourceLabel(value?: string): string {
  const source = value || "";
  const labels: Record<string, string> = { dom: "页面元素", network: "网络响应", timing: "资源记录", rule: "提取规则", worker: "Worker", "blob-manifest": "内存清单", pick: "页面拾取" };
  if (labels[source]) return labels[source];
  if (source.endsWith("-member")) return "清单成员";
  if (source.startsWith("inline-script") || source.startsWith("page-probe")) return "页面脚本";
  if (source.startsWith("blob")) return "内存数据";
  if (/^(?:fetch|xhr)(?:$|-)/.test(source)) return source === "fetch" || source === "xhr" ? "页面请求" : "请求响应体";
  return "其他来源";
}

export function typeLabel(value?: string): string {
  const labels: Record<string, string> = { video: "视频", audio: "音频", image: "图片", hls: "HLS", dash: "DASH", segment: "分片" };
  return labels[value || ""] || String(value || "资源").toUpperCase();
}
/** The directory part of a Windows or POSIX file path. */
export function folderOf(path: string) { const index = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/")); return index > 0 ? path.slice(0, index) : path; }
