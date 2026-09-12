import { sendMessage } from "../../api";
export async function configurationRequest<T>(type: string, payload?: unknown): Promise<T> {
  const result = await sendMessage<{ ok: boolean; value?: T; error?: string }>({ type, payload: payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)) });
  if (!result?.ok) throw new Error(result?.error || "配置操作失败");
  return result.value as T;
}
export async function openTrustedSettings() { await sendMessage({ type: "settings.open" }); }
export async function openDispatch(tabId: number, sourceContextId: string, candidateIds: string[]) {
  const result = await sendMessage({ type: "integration.open", payload: { tabId, sourceContextId, candidateIds } });
  if (!result?.ok) throw new Error(result?.error || "无法打开外部调用确认页");
}
export async function openCapture(tabId: number, sourceContextId: string, objectUrl: string) {
  const result = await sendMessage({ type: "capture.control.open", payload: { tabId, sourceContextId, objectUrl } });
  if (!result?.ok) throw new Error(result?.error || "无法打开捕捉控制页");
}
