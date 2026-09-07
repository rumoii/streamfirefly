use serde_json::Value;

pub(crate) const DEFAULT_DOWNLOAD_THREADS: u8 = 6;
pub(crate) const MAX_DOWNLOAD_THREADS: u8 = 16;
pub(crate) const INLINE_MANIFEST_MAX_BYTES: usize = 512 * 1024;
pub(crate) fn default_download_threads() -> u8 {
    DEFAULT_DOWNLOAD_THREADS
}

pub(crate) fn download_threads(value: &Value) -> u8 {
    value["downloadThreads"]
        .as_u64()
        .map(|value| value.clamp(1, MAX_DOWNLOAD_THREADS as u64) as u8)
        .unwrap_or(DEFAULT_DOWNLOAD_THREADS)
}
