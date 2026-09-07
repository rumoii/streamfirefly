use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Track {
    pub(crate) generation: u32,
    pub(crate) id: u32,
    pub(crate) mime: String,
    pub(crate) bytes: u64,
    pub(crate) next_sequence: u64,
    pub(crate) last_chunk_size: u64,
    pub(crate) initialized: bool,
    pub(crate) file: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Snapshot {
    pub(crate) version: u8,
    pub(crate) id: String,
    pub(crate) state: String,
    pub(crate) bytes: u64,
    pub(crate) tracks: Vec<Track>,
    pub(crate) output: Option<String>,
    pub(crate) outputs: Vec<String>,
    pub(crate) error: Option<String>,
}

pub(crate) struct Session {
    pub(crate) snapshot: Snapshot,
    pub(crate) directory: PathBuf,
    pub(crate) stop: bool,
    pub(crate) worker_active: bool,
}
