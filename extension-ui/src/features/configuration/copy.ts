import { extensionApi, sendMessage } from "../../api";
import type { MediaCandidate } from "../../types";
export async function copyResources(candidates: MediaCandidate[]) {
  if (!candidates.length) return;
  let content = candidates.map(candidate => candidate.url).join("\n");
  if (extensionApi()?.runtime?.sendMessage) {
    const context = await sendMessage({ type: "ui.context.get", scope: "active" });
    const response = await sendMessage({ type: "media.copy", payload: { tabId: context.context?.sourceTabId, ids: candidates.map(candidate => candidate.id) } });
    if (!response.ok) throw new Error(response.error || "复制失败");
    content = response.value;
  }
  await navigator.clipboard.writeText(content);
}
