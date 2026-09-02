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

export function sourceLabel(value?: string): string {
  const labels: Record<string, string> = { dom: "页面元素", network: "网络响应", "inline-script": "页面脚本", "fetch-body": "请求响应体", "blob-manifest": "内存清单", worker: "Worker" };
  return labels[value || ""] || "页面脚本";
}

export function typeLabel(value?: string): string {
  const labels: Record<string, string> = { video: "视频", audio: "音频", image: "图片", hls: "HLS", dash: "DASH", segment: "分片" };
  return labels[value || ""] || String(value || "资源").toUpperCase();
}
