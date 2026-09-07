use super::*;

#[derive(Debug, Clone)]
pub(super) struct InlineManifest {
    pub(super) text: String,
    pub(super) base_url: String,
}

#[derive(Debug, Clone)]
pub(super) struct HlsSubtitlePlan {
    pub(super) language: Option<String>,
    pub(super) label: Option<String>,
    pub(super) extension: String,
    pub(super) manifest: InlineManifest,
}

#[derive(Debug, Clone)]
pub(super) struct HlsPlan {
    pub(super) version: u8,
    pub(super) duration: f64,
    pub(super) container: String,
    pub(super) video_manifest: InlineManifest,
    pub(super) audio_manifest: Option<InlineManifest>,
    pub(super) subtitles: Vec<HlsSubtitlePlan>,
    pub(super) key_override: Option<KeyOverride>,
    pub(super) live: bool,
    pub(super) poll_interval_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct TaskOutput {
    pub(super) kind: String,
    #[serde(default)]
    pub(super) language: Option<String>,
    #[serde(default)]
    pub(super) label: Option<String>,
    #[serde(default)]
    pub(super) path: Option<String>,
    pub(super) state: String,
    #[serde(default)]
    pub(super) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct Task {
    pub(super) id: String,
    #[serde(default)]
    pub(super) revision: u64,
    #[serde(default)]
    pub(super) request_id: Option<String>,
    pub(super) url: String,
    pub(super) title: String,
    pub(super) state: String,
    #[serde(default)]
    pub(super) phase: String,
    pub(super) progress: u8,
    #[serde(default)]
    pub(super) downloaded_bytes: u64,
    #[serde(default)]
    pub(super) total_bytes: Option<u64>,
    #[serde(default)]
    pub(super) speed_bytes_per_second: u64,
    #[serde(default)]
    pub(super) eta_seconds: Option<u64>,
    #[serde(default)]
    pub(super) attempt: u8,
    #[serde(default)]
    pub(super) message: Option<String>,
    pub(super) output: Option<String>,
    pub(super) error: Option<String>,
    pub(super) mime: Option<String>,
    #[serde(default)]
    pub(super) referer: Option<String>,
    #[serde(default = "default_download_threads")]
    pub(super) download_threads: u8,
    #[serde(default)]
    pub(super) request_headers: HashMap<String, String>,
    #[serde(default)]
    pub(super) active_connections: u8,
    #[serde(default)]
    pub(super) segments_completed: u32,
    #[serde(default)]
    pub(super) segments_total: u32,
    #[serde(default)]
    pub(super) source_context_id: Option<String>,
    #[serde(default)]
    pub(super) outputs: Vec<TaskOutput>,
    #[serde(default)]
    pub(super) hls_selection: bool,
    #[serde(default)]
    pub(super) hls_plan_version: u8,
    #[serde(default)]
    pub(super) failed_segments: u32,
    #[serde(default)]
    pub(super) retry_count: u32,
    #[serde(default)]
    pub(super) checkpoint_state: Option<String>,
    #[serde(default)]
    pub(super) resume_requirement: Option<String>,
    #[serde(default)]
    pub(super) requires_authorization: bool,
    #[serde(default)]
    pub(super) requires_key_override: bool,
    #[serde(default)]
    pub(super) live_recording: bool,
    #[serde(default)]
    pub(super) recorded_duration: f64,
    #[serde(default)]
    pub(super) last_media_sequence: Option<u64>,
    #[serde(default)]
    pub(super) source_candidate_id: Option<String>,
    #[serde(skip)]
    pub(super) inline_manifest: Option<InlineManifest>,
    #[serde(skip)]
    pub(super) hls_plan: Option<HlsPlan>,
}
