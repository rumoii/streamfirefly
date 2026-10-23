export type CandidateType = "video" | "audio" | "image" | "hls" | "dash" | "segment" | string;

export interface MediaCandidate {
  extraction?: import("../../shared/extraction").ExtractionOrigin;
  id: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  pageTitle?: string;
  pageUrl?: string;
  type: CandidateType;
  mime?: string;
  size?: number | null;
  /** Where the size came from: "content-range", "content-length" or "probe". */
  sizeSource?: string | null;
  sizeKind?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  poster?: string | null;
  /** "preview" when the cover was captured from the preview player, "dom-fallback" when borrowed from the page's only video. */
  posterSource?: string;
  live?: boolean | null;
  detectedAt?: number;
  source?: string;
  referer?: string;
  requestHeaders?: Record<string, string>;
  contentDisposition?: string;
  inlineManifest?: { format: string; baseUrl: string; text: string } | null;
  /** Canonical addresses of the master playlists that list this variant playlist. */
  parents?: string[];
  /** Set on images the user picked on the page; they stay listed with image detection off. */
  userPicked?: boolean;
}

export interface ResourceViewState {
  pattern: string;
  type: "all" | "video" | "audio" | "image";
  minMb: string;
  maxMb: string;
  minDuration: string;
  maxDuration: string;
  sortMode: "detected" | "size" | "duration";
  expandedId: string;
  revision: number;
}

export interface UiContext {
  sourceContextId: string;
  sourceTabId: number;
  pageUrl: string;
  pageTitle: string;
  favIconUrl: string;
  supported: boolean;
  /** Set when the page is on a site excluded by BLOCKED_SITES. */
  blocked?: boolean;
  paused: boolean;
  sniffingActive: boolean;
  candidates: MediaCandidate[];
  resourceViewState: ResourceViewState;
  /** The video the page is currently playing, used to pin it and its downloadable copies. */
  focus?: PageFocus | null;
  /** The element the user picked on the page; it and its other resolutions are pinned first. */
  pick?: PagePick | null;
  /** True while the page is waiting for the user to click a video, audio or image. */
  picking?: boolean;
}

export interface PageFocus {
  url: string;
  poster?: string | null;
  duration?: number | null;
}

export interface PagePick {
  kind: "video" | "audio" | "image";
  /** The element's current address first, then its other sources (`<source>`, srcset, `<picture>`). */
  urls: string[];
  poster?: string | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
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
  revision?: number;
  request_id?: string | null;
  url?: string;
  title: string;
  state: string;
  phase?: string;
  progress: number;
  downloaded_bytes?: number;
  total_bytes?: number | null;
  speed_bytes_per_second?: number;
  eta_seconds?: number | null;
  segments_completed?: number;
  segments_total?: number;
  output?: string | null;
  mime?: string | null;
  outputs?: TaskOutput[];
  message?: string | null;
  error?: string | null;
  source_context_id?: string | null;
  hls_selection?: boolean;
  dash_selection?: boolean;
  hls_plan_version?: number;
  failed_segments?: number;
  retry_count?: number;
  checkpoint_state?: string | null;
  resume_requirement?: "authorization_required" | "key_required" | "authorization_and_key_required" | "dash_reparse_required" | null;
  live_recording?: boolean;
  recorded_duration?: number;
  last_media_sequence?: number | null;
  source_candidate_id?: string | null;
}
