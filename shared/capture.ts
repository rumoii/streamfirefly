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
  tracks: { id: number; mime: string; bytes: number; initialized: boolean }[];
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
  "capture.open": { payload: { tabId: number; sourceContextId: string; source: CaptureSource; directory: string; objectUrl?: string }; value: { id: string } };
  "capture.close": { payload: { tabId: number; id: string }; value: void };
  "capture.list": { payload: undefined; value: CaptureSnapshot[] };
  "capture.recover": { payload: { id: string }; value: unknown };
  "deep.status": { payload: { tabId: number }; value: DeepSearchStatus };
  "deep.set": { payload: { tabId: number; enabled: boolean; remember: boolean }; value: DeepSearchStatus };
}
