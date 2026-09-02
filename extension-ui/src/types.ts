export type CandidateType = "video" | "audio" | "image" | "hls" | "dash" | "segment" | string;

export interface MediaCandidate {
  id: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  pageTitle?: string;
  pageUrl?: string;
  type: CandidateType;
  mime?: string;
  size?: number | null;
  sizeKind?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  poster?: string | null;
  detectedAt?: number;
  source?: string;
  referer?: string;
  requestHeaders?: Record<string, string>;
  contentDisposition?: string;
  inlineManifest?: { format: string; baseUrl: string; text: string } | null;
}

export interface PageContext {
  sessionId: string;
  sourceContextId: string;
  sourceTabId: number | null;
  appTabId: number | null;
  pageUrl: string;
  pageTitle: string;
  favIconUrl?: string;
  sourceClosed: boolean;
  supported: boolean;
  paused: boolean;
}

export interface TaskOutput {
  kind: "media" | "subtitle";
  language?: string | null;
  label?: string | null;
  path?: string | null;
  state: string;
  error?: string | null;
}

export interface DownloadTask {
  id: string;
  title: string;
  state: string;
  phase?: string;
  progress: number;
  downloaded_bytes?: number;
  total_bytes?: number | null;
  speed_bytes_per_second?: number;
  eta_seconds?: number | null;
  output?: string | null;
  outputs?: TaskOutput[];
  message?: string | null;
  error?: string | null;
  source_context_id?: string | null;
  hls_selection?: boolean;
}
