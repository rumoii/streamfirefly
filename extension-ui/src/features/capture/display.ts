import type { CaptureSnapshot } from "../../../../shared/capture";

export const CAPTURE_STATE_LABELS: Record<string, string> = { armed: "等待数据", capturing: "录制中", stopping: "正在停止", finalizing: "正在生成文件", complete: "已保存", partial: "未完成", interrupted: "已中断", unavailable: "记录损坏" };
export const isFinishedCapture = (session: CaptureSnapshot) => ["complete", "partial", "interrupted"].includes(session.state);

function hostOf(url?: string) { try { return url ? new URL(url).hostname : ""; } catch { return ""; } }
export function captureTitle(session: CaptureSnapshot) { return session.pageTitle || hostOf(session.pageUrl || session.source?.url) || "未知页面"; }

// Stock Windows players lack AV1 and HEVC decoders, so recordings in these codecs open with sound only.
export function modernCodec(session: CaptureSnapshot) {
  const mimes = session.tracks.map(track => track.mime.toLowerCase());
  return mimes.some(mime => mime.includes("av01")) ? "AV1" : mimes.some(mime => /hvc1|hev1/.test(mime)) ? "HEVC" : "";
}
export function codecHint(session: CaptureSnapshot) {
  const codec = modernCodec(session);
  if (codec === "AV1") return "视频是 AV1 编码。Windows 自带的媒体播放器要先在微软商店安装免费的“AV1 Video Extension”，也可以用 VLC 或 PotPlayer 播放。";
  if (codec === "HEVC") return "视频是 HEVC（H.265）编码。Windows 自带的媒体播放器要先在微软商店安装“HEVC 视频扩展”，也可以用 VLC 或 PotPlayer 播放。";
  return "打不开或只有声音？通常是播放器不支持这个视频的编码格式，换用 VLC 或 PotPlayer 一般就能播放。";
}
