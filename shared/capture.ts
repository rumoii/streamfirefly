export interface CaptureSource {
  id: string;
  frameId: number;
  documentToken: string;
  documentId?: string;
  url: string;
  state: string;
  tracks: string[];
  objectUrls: string[];
}
export interface FrameStatus {
  frameId: number;
  url: string;
  state: "ready" | "disabled" | "failed" | "unsupported";
  error?: string;
  requiresReload?: boolean;
}
export interface CaptureSources { sources: CaptureSource[]; frames: FrameStatus[] }
export interface CaptureSnapshot {
  id: string;
  state: "armed" | "capturing" | "stopping" | "finalizing" | "complete" | "partial" | "interrupted" | "unavailable";
  bytes: number;
  output?: string;
  outputs: string[];
  error?: string;
  tabId?: number;
  source?: CaptureSource;
  ended?: boolean;
  speed?: number;
  speedOverridden?: boolean;
  paused?: boolean;
  tracks: { id: number; mime: string; bytes: number; initialized: boolean }[];
  createdAt?: number;
  pageTitle?: string;
  pageUrl?: string;
}
export interface DeepSearchStatus {
  enabled: boolean;
  siteRemembered: boolean;
  requiresReload: boolean;
  frames: FrameStatus[];
  keys: { hex: string; source: string; frameId: number }[];
}
export interface CaptureRequests {
  "capture.sources": { payload: { tabId: number }; value: CaptureSources };
  "capture.open": { payload: { tabId: number; sourceContextId: string; source: CaptureSource; directory: string; objectUrl?: string; restartOperation?: string }; value: { id: string } };
  "capture.restart": { payload: { tabId: number; sourceContextId: string }; value: { operationId: string } };
  "capture.restart.status": { payload: { tabId: number; operationId: string }; value: CaptureSources & { phase: string; sourceContextId: string } };
  "capture.replay": { payload: { tabId: number; id: string }; value: void };
  "capture.speed": { payload: { tabId: number; id: string; speed: number }; value: { rate: number } };
  "capture.close": { payload: { tabId: number; id: string }; value: void };
  "capture.list": { payload: undefined; value: CaptureSnapshot[] };
  "capture.recover": { payload: { id: string }; value: unknown };
  "capture.reveal": { payload: { id: string; path: string }; value: { id: string } };
  "capture.delete": { payload: { id: string }; value: { id: string } };
  "deep.status": { payload: { tabId: number }; value: DeepSearchStatus };
  "deep.set": { payload: { tabId: number; enabled: boolean; remember: boolean }; value: DeepSearchStatus };
}
