import { sendMessage } from "../../api";

export const RELEASES_URL = "https://github.com/rumoii/streamfirefly/releases/latest";

export interface UpdateStatus { enabled: boolean; currentVersion: string; latestVersion: string; releaseUrl: string; hasUpdate: boolean }
type UpdateResponse = { ok: boolean; value?: UpdateStatus; error?: string };

async function request(type: "update.check" | "update.auto" | "update.dismiss", payload?: unknown): Promise<UpdateStatus> {
  const response = await sendMessage<UpdateResponse>(payload === undefined ? { type } : { type, payload });
  if (!response?.ok || !response.value) throw new Error(response?.error || "update_unreachable");
  return response.value;
}

export const checkUpdate = () => request("update.check");
export const autoCheckUpdate = () => request("update.auto");
export const dismissUpdate = (version: string) => request("update.dismiss", { version });

export function updateErrorText(error: string) {
  if (error === "update_unreachable") return "连不上 GitHub，请开启浏览器或系统代理后重试。";
  if (error === "update_invalid") return "GitHub 返回的版本信息无法识别，请稍后重试或直接打开下载页。";
  return `检查失败：${error}`;
}
