use crate::hls::KeyOverride;
use crate::network::NetworkConfig;
use crate::settings::default_download_threads;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone)]
pub(crate) struct InlineManifest {
    pub(crate) text: String,
    pub(crate) base_url: String,
}

#[derive(Debug, Clone)]
pub(crate) struct HlsSubtitlePlan {
    pub(crate) language: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) extension: String,
    pub(crate) manifest: InlineManifest,
}

#[derive(Debug, Clone)]
pub(crate) struct HlsPlan {
    pub(crate) version: u8,
    pub(crate) duration: f64,
    pub(crate) container: String,
    pub(crate) video_manifest: InlineManifest,
    pub(crate) audio_manifest: Option<InlineManifest>,
    pub(crate) subtitles: Vec<HlsSubtitlePlan>,
    pub(crate) key_override: Option<KeyOverride>,
    pub(crate) live: bool,
    pub(crate) poll_interval_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct TaskOutput {
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) language: Option<String>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) path: Option<String>,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Task {
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) revision: u64,
    #[serde(default)]
    pub(crate) request_id: Option<String>,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) phase: String,
    pub(crate) progress: u8,
    #[serde(default)]
    pub(crate) downloaded_bytes: u64,
    #[serde(default)]
    pub(crate) total_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) speed_bytes_per_second: u64,
    #[serde(default)]
    pub(crate) eta_seconds: Option<u64>,
    #[serde(default)]
    pub(crate) attempt: u8,
    #[serde(default)]
    pub(crate) message: Option<String>,
    pub(crate) output: Option<String>,
    pub(crate) error: Option<String>,
    pub(crate) mime: Option<String>,
    #[serde(default)]
    pub(crate) referer: Option<String>,
    #[serde(default = "default_download_threads")]
    pub(crate) download_threads: u8,
    #[serde(default)]
    pub(crate) request_headers: HashMap<String, String>,
    #[serde(default)]
    pub(crate) active_connections: u8,
    #[serde(default)]
    pub(crate) segments_completed: u32,
    #[serde(default)]
    pub(crate) segments_total: u32,
    #[serde(default)]
    pub(crate) source_context_id: Option<String>,
    #[serde(default)]
    pub(crate) outputs: Vec<TaskOutput>,
    #[serde(default)]
    pub(crate) hls_selection: bool,
    #[serde(default)]
    pub(crate) dash_selection: bool,
    #[serde(skip)]
    pub(crate) dash_plan: Option<crate::dash::DashPlan>,
    #[serde(default)]
    pub(crate) hls_plan_version: u8,
    #[serde(default)]
    pub(crate) failed_segments: u32,
    #[serde(default)]
    pub(crate) retry_count: u32,
    #[serde(default)]
    pub(crate) checkpoint_state: Option<String>,
    #[serde(default)]
    pub(crate) resume_requirement: Option<String>,
    #[serde(default)]
    pub(crate) requires_authorization: bool,
    #[serde(default)]
    pub(crate) requires_key_override: bool,
    #[serde(default)]
    pub(crate) live_recording: bool,
    #[serde(default)]
    pub(crate) recorded_duration: f64,
    #[serde(default)]
    pub(crate) last_media_sequence: Option<u64>,
    #[serde(default)]
    pub(crate) source_candidate_id: Option<String>,
    #[serde(skip)]
    pub(crate) inline_manifest: Option<InlineManifest>,
    #[serde(skip)]
    pub(crate) hls_plan: Option<HlsPlan>,
    #[serde(skip)]
    pub(crate) network: NetworkConfig,
}
