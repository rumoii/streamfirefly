use crate::capture_model::{Session, Snapshot};
use crate::persistence::replace_file;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;

pub(crate) struct Catalog {
    pub(crate) sessions: HashMap<String, Arc<Mutex<Session>>>,
    pub(crate) errors: Vec<Value>,
}

fn read_snapshot(directory: &Path) -> Result<Snapshot, String> {
    let path = directory.join("capture.json");
    if !fs::symlink_metadata(directory)
        .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        || !fs::symlink_metadata(&path).is_ok_and(|metadata| {
            metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 65536
        })
    {
        return Err("capture_checkpoint_unreadable".into());
    }
    let bytes = fs::read(path).map_err(|_| "capture_checkpoint_unreadable")?;
    let mut snapshot: Snapshot =
        serde_json::from_slice(&bytes).map_err(|_| "capture_checkpoint_invalid")?;
    let mut tracks = HashSet::new();
    if snapshot.version != 1
        || Uuid::parse_str(&snapshot.id).is_err()
        || directory.file_name().and_then(|name| name.to_str())
            != Some(format!("capture-{}", snapshot.id).as_str())
        || ![
            "armed",
            "capturing",
            "stopping",
            "finalizing",
            "complete",
            "partial",
            "interrupted",
        ]
        .contains(&snapshot.state.as_str())
        || snapshot.tracks.len() > 32
        || snapshot.tracks.iter().any(|track| {
            !tracks.insert(track.id)
                || track.generation >= 32
                || track.id >= 32
                || track.last_chunk_size > track.bytes
                || track.bytes > 64 * 1024 * 1024 * 1024
                || track.file
                    != format!(
                        "track-{}.{}",
                        track.id,
                        if track.mime.contains("webm") {
                            "webm"
                        } else {
                            "mp4"
                        }
                    )
                || fs::symlink_metadata(directory.join(&track.file))
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
        })
        || snapshot.tracks.iter().map(|track| track.bytes).sum::<u64>() != snapshot.bytes
    {
        return Err("capture_checkpoint_invalid".into());
    }
    if ["armed", "capturing", "stopping", "finalizing"].contains(&snapshot.state.as_str()) {
        snapshot.state = "interrupted".into();
        snapshot.error = Some("capture_host_restarted".into());
    }
    Ok(snapshot)
}

pub(crate) fn load(root: &Path) -> Catalog {
    let mut catalog = Catalog {
        sessions: HashMap::new(),
        errors: Vec::new(),
    };
    let mut directories = HashSet::new();
    if let Ok(entries) = fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with("capture-") && entry.path().is_dir()
            {
                directories.insert(entry.path());
            }
        }
    }
    let index = root.join("capture-index.json");
    if index.exists() {
        let loaded = (|| -> Result<Vec<PathBuf>, ()> {
            if !fs::symlink_metadata(&index).is_ok_and(|metadata| {
                metadata.is_file() && !metadata.file_type().is_symlink() && metadata.len() <= 65536
            }) {
                return Err(());
            }
            let paths: Vec<PathBuf> =
                serde_json::from_slice(&fs::read(&index).map_err(|_| ())?).map_err(|_| ())?;
            if paths.len() > 100 || paths.iter().any(|path| !path.is_absolute()) {
                return Err(());
            }
            Ok(paths)
        })();
        match loaded { Ok(paths) => directories.extend(paths), Err(_) => catalog.errors.push(serde_json::json!({"id":"catalog", "state":"unavailable", "bytes":0, "tracks":[], "error":"capture_index_invalid"})) }
    }
    for directory in directories {
        let failure = match read_snapshot(&directory) {
            Ok(snapshot) if !catalog.sessions.contains_key(&snapshot.id) => {
                catalog.sessions.insert(
                    snapshot.id.clone(),
                    Arc::new(Mutex::new(Session {
                        snapshot,
                        directory,
                        stop: true,
                        worker_active: false,
                    })),
                );
                continue;
            }
            Ok(_) => "capture_duplicate_session".into(),
            Err(error) => error,
        };
        catalog.errors.push(serde_json::json!({"id":directory.to_string_lossy(), "state":"unavailable", "bytes":0, "tracks":[], "error":failure}));
    }
    catalog
}

pub(crate) fn save_index(root: &Path, directories: &[PathBuf]) -> io::Result<()> {
    fs::create_dir_all(root)?;
    let temporary = root.join("capture-index.tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&serde_json::to_vec(directories)?)?;
    file.sync_all()?;
    drop(file);
    replace_file(&temporary, &root.join("capture-index.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_corruption_and_preserves_checkpoint_bytes() {
        let root = std::env::temp_dir().join(format!("capture-catalog-{}", Uuid::new_v4()));
        let directory = root.join(format!("capture-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("capture.json"), b"broken").unwrap();
        let catalog = load(&root);
        assert_eq!(catalog.errors.len(), 1);
        assert!(catalog.sessions.is_empty());
        assert_eq!(fs::read(directory.join("capture.json")).unwrap(), b"broken");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn indexes_custom_output_roots_and_marks_restart_interrupted() {
        let root = std::env::temp_dir().join(format!("capture-catalog-{}", Uuid::new_v4()));
        let id = Uuid::new_v4().to_string();
        let directory = root.join("custom").join(format!("capture-{id}"));
        fs::create_dir_all(&directory).unwrap();
        let snapshot = Snapshot {
            version: 1,
            id: id.clone(),
            state: "capturing".into(),
            bytes: 0,
            tracks: Vec::new(),
            output: None,
            outputs: Vec::new(),
            error: None,
        };
        fs::write(
            directory.join("capture.json"),
            serde_json::to_vec(&snapshot).unwrap(),
        )
        .unwrap();
        save_index(&root, &[directory]).unwrap();
        let catalog = load(&root);
        assert!(catalog.errors.is_empty());
        assert_eq!(
            catalog.sessions[&id].lock().unwrap().snapshot.state,
            "interrupted"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
