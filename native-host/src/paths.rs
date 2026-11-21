use std::path::Path;
use std::path::PathBuf;

pub(crate) fn state_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StreamFirefly")
        .join("tasks.json")
}

pub(crate) fn task_work_root_for_state(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join("tasks")
}

pub(crate) fn checkpoint_path_for_state(path: &Path, id: &str) -> PathBuf {
    task_work_root_for_state(path)
        .join(id)
        .join("checkpoint.json")
}

pub(crate) fn checkpoint_available(path: &Path) -> bool {
    path.is_file() || path.with_extension("bak").is_file()
}

pub(crate) fn default_download_dir() -> PathBuf {
    state_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join("downloads")
}
