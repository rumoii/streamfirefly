import type { DownloadTask, MediaCandidate, ResourceViewState, UiContext } from "./types";
import type { buildHlsPlan } from "./download-plan";

export interface DownloadRequest {
  requestId?: string;
  url: string;
  candidateId: string;
  sourceContextId?: string | null;
  title: string;
  fileName?: string;
  saveDir?: string | null;
  downloadThreads?: number;
  requestHeaders: Record<string, string>;
  hlsPlan?: Awaited<ReturnType<typeof buildHlsPlan>> | null;
}

export interface CoreRequests {
  "ui.context.get": { type: "ui.context.get"; scope: "sender" | "active"; windowId: number | null };
  "ui.resource-state.patch": { type: "ui.resource-state.patch"; scope: "sender" | "active"; tabId: number; windowId: number | null; sourceContextId: string; patch: Partial<Omit<ResourceViewState, "revision">> };
  "native.connect": { type: "native.connect" };
  "task.list": { type: "task.list" };
  "task.find": { type: "task.find"; payload: { requestId: string } };
  "task.create": { type: "task.create"; payload: DownloadRequest & { requestId: string } };
  "task.control": { type: "task.control"; payload: { id: string; action: string; resumeContext?: Record<string, unknown> | null } };
}

export interface CoreResponses {
  "ui.context.get": { ok: boolean; error?: string; context?: UiContext };
  "ui.resource-state.patch": { ok: boolean; error?: string; state?: ResourceViewState };
  "native.connect": { ok: boolean; error?: string; capabilities?: string[] };
  "task.list": { ok: boolean; error?: string; tasks?: DownloadTask[] };
  "task.find": { ok: boolean; error?: string; task?: DownloadTask | null };
  "task.create": { ok: boolean; error?: string; task?: DownloadTask };
  "task.control": { ok: boolean; error?: string; task?: DownloadTask };
}

export type RuntimeEvent = { type: "task.progress"; task: DownloadTask } | { type: "task.deleted"; id: string } | { type: "native.disconnected" | "task.persistence-error"; error: string } | { type: "ui.resource-state.changed"; sourceContextId: string; state: ResourceViewState };
export type CandidateMetadata = Partial<Pick<MediaCandidate, "duration" | "width" | "height" | "poster" | "live">>;
