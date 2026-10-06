use crate::capture_catalog::{load, save_index};
use crate::capture_diagnostics::record;
use crate::capture_merge::finalize;
use crate::capture_model::{Session, Snapshot};
use crate::capture_socket::receive;
use crate::capture_storage::save;
use crate::task_input::validate_dir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use uuid::Uuid;

pub(crate) struct CaptureManager {
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
    root: PathBuf,
    errors: Vec<Value>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

impl CaptureManager {
    pub(crate) fn new(root: PathBuf) -> Self {
        let catalog = load(&root);
        Self {
            sessions: Mutex::new(catalog.sessions),
            root,
            errors: catalog.errors,
            workers: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn open(&self, payload: &Value) -> Result<Value, String> {
        if !self.errors.is_empty() {
            return Err("capture_catalog_requires_repair".into());
        }
        let origin = payload["origin"]
            .as_str()
            .filter(|value| {
                ["chrome-extension://", "moz-extension://"]
                    .iter()
                    .any(|prefix| {
                        value.strip_prefix(prefix).is_some_and(|host| {
                            !host.is_empty()
                                && host
                                    .bytes()
                                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                        })
                    })
            })
            .ok_or("capture_origin_invalid")?
            .to_owned();
        let mut sessions = self.sessions.lock().map_err(|_| "capture_unavailable")?;
        if sessions.len() >= 100
            || sessions
                .values()
                .filter(|session| {
                    session.lock().is_ok_and(|value| {
                        ["armed", "capturing", "stopping", "finalizing"]
                            .contains(&value.snapshot.state.as_str())
                    })
                })
                .count()
                >= 2
        {
            return Err("capture_capacity".into());
        }
        let base = match payload["directory"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            Some(value) => validate_dir(value).map_err(str::to_string)?,
            None => self.root.clone(),
        };
        let id = Uuid::new_v4().to_string();
        let directory = base.join(format!("capture-{id}"));
        fs::create_dir_all(&directory).map_err(|_| "capture_directory_failed")?;
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| "capture_listener_failed")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "capture_listener_failed")?;
        let port = listener
            .local_addr()
            .map_err(|_| "capture_listener_failed")?
            .port();
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let session = Arc::new(Mutex::new(Session {
            snapshot: Snapshot {
                version: 1,
                id: id.clone(),
                state: "armed".into(),
                bytes: 0,
                tracks: Vec::new(),
                output: None,
                outputs: Vec::new(),
                error: None,
                created_at: now_millis(),
                page_title: bounded_text(&payload["pageTitle"], 300),
                page_url: bounded_text(&payload["pageUrl"], 2048).filter(|value| {
                    value.starts_with("https://") || value.starts_with("http://")
                }),
            },
            directory,
            stop: false,
            worker_active: true,
        }));
        {
            let current = session.lock().map_err(|_| "capture_unavailable")?;
            save(&current).map_err(|_| "capture_checkpoint_failed")?;
            record(
                &current,
                "session-created",
                json!({"state":current.snapshot.state}),
            );
        }
        let working = session.clone();
        let mut directories = sessions
            .values()
            .filter_map(|entry| entry.lock().ok().map(|value| value.directory.clone()))
            .collect::<Vec<_>>();
        directories.push(
            session
                .lock()
                .map_err(|_| "capture_unavailable")?
                .directory
                .clone(),
        );
        save_index(&self.root, &directories).map_err(|_| "capture_index_write_failed")?;
        let secret = token.clone();
        let worker = thread::Builder::new()
            .name("capture-stream".into())
            .spawn(move || {
                let result = receive(listener, &origin, &secret, &working);
                if let Ok(mut session) = working.lock() {
                    record(
                        &session,
                        "receive-ended",
                        json!({"error":result.as_ref().err()}),
                    );
                    if let Err(error) = result {
                        session.snapshot.error = Some(error);
                        session.snapshot.state = "interrupted".into();
                    } else if session.snapshot.state != "interrupted" {
                        session.snapshot.state = "finalizing".into();
                    }
                    let _ = save(&session);
                }
                if result_is_finalizing(&working) {
                    finalize(&working);
                }
                if let Ok(mut current) = working.lock() {
                    current.worker_active = false;
                    record(
                        &current,
                        "worker-ended",
                        json!({"state":current.snapshot.state}),
                    );
                }
            })
            .map_err(|_| {
                if let Ok(mut current) = session.lock() {
                    current.worker_active = false;
                    current.stop = true;
                    current.snapshot.state = "interrupted".into();
                    current.snapshot.error = Some("capture_thread_failed".into());
                    let _ = save(&current);
                }
                sessions.insert(id.clone(), session.clone());
                "capture_thread_failed"
            })?;
        self.track_worker(worker);
        sessions.insert(id.clone(), session);
        Ok(
            json!({"id":id,"endpoint":format!("ws://127.0.0.1:{port}"),"token":token,"expiresInSeconds":30}),
        )
    }

    fn track_worker(&self, worker: thread::JoinHandle<()>) {
        let mut workers = self.workers.lock().unwrap();
        workers.retain(|worker| !worker.is_finished());
        workers.push(worker);
    }

    pub(crate) fn list(&self) -> Value {
        let sessions = self.sessions.lock().unwrap();
        let mut snapshots = sessions
            .values()
            .filter_map(|session| session.lock().ok().map(|value| value.snapshot.clone()))
            .collect::<Vec<_>>();
        snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| a.id.cmp(&b.id)));
        let mut entries = snapshots.iter().map(|snapshot| json!(snapshot)).collect::<Vec<_>>();
        entries.extend(self.errors.clone());
        json!(entries)
    }

    /// Removes a finished session together with its directory, including saved outputs.
    pub(crate) fn delete(&self, payload: &Value) -> Result<Value, String> {
        let id = payload["id"].as_str().ok_or("capture_id_required")?;
        let mut sessions = self.sessions.lock().map_err(|_| "capture_unavailable")?;
        let session = sessions.get(id).cloned().ok_or("capture_not_found")?;
        let directory = {
            let current = session.lock().map_err(|_| "capture_unavailable")?;
            if current.worker_active
                || !["complete", "partial", "interrupted"].contains(&current.snapshot.state.as_str())
            {
                return Err("capture_delete_active".into());
            }
            current.directory.clone()
        };
        let expected = format!("capture-{}", Uuid::parse_str(id).map_err(|_| "capture_not_found")?);
        if directory.file_name().and_then(|name| name.to_str()) != Some(expected.as_str()) {
            return Err("capture_delete_failed".into());
        }
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err("capture_delete_failed".into())
            }
            Ok(_) => fs::remove_dir_all(&directory).map_err(|_| "capture_delete_failed")?,
            Err(_) => {}
        }
        sessions.remove(id);
        let directories = sessions
            .values()
            .filter_map(|entry| entry.lock().ok().map(|value| value.directory.clone()))
            .collect::<Vec<_>>();
        save_index(&self.root, &directories).map_err(|_| "capture_index_write_failed")?;
        Ok(json!({"id":id}))
    }

    pub(crate) fn stop(&self, payload: &Value, aborted: bool) -> Result<Value, String> {
        let id = payload["id"].as_str().ok_or("capture_id_required")?;
        let session = self
            .sessions
            .lock()
            .map_err(|_| "capture_unavailable")?
            .get(id)
            .cloned()
            .ok_or("capture_not_found")?;
        let mut current = session.lock().map_err(|_| "capture_unavailable")?;
        if !aborted && ["interrupted", "partial"].contains(&current.snapshot.state.as_str()) {
            if current.worker_active {
                return Err("capture_worker_stopping".into());
            }
            let previous = current.snapshot.state.clone();
            current.snapshot.state = "finalizing".into();
            if save(&current).is_err() {
                current.snapshot.state = previous;
                return Err("capture_checkpoint_failed".into());
            }
            current.worker_active = true;
            let snapshot = json!(current.snapshot);
            drop(current);
            let recovery = session.clone();
            let worker = thread::Builder::new()
                .name("capture-recover".into())
                .spawn(move || {
                    finalize(&recovery);
                    if let Ok(mut current) = recovery.lock() {
                        current.worker_active = false;
                    }
                })
                .map_err(|_| {
                    if let Ok(mut current) = session.lock() {
                        current.worker_active = false;
                        current.snapshot.state = "interrupted".into();
                        current.snapshot.error = Some("capture_thread_failed".into());
                        let _ = save(&current);
                    }
                    "capture_thread_failed"
                })?;
            self.track_worker(worker);
            return Ok(snapshot);
        }
        if ["armed", "capturing", "stopping"].contains(&current.snapshot.state.as_str())
            || aborted && current.snapshot.state == "finalizing"
        {
            current.stop = true;
            current.snapshot.state = if aborted { "interrupted" } else { "stopping" }.into();
            save(&current).map_err(|_| "capture_checkpoint_failed")?;
        }
        Ok(json!(current.snapshot))
    }
}

impl Drop for CaptureManager {
    fn drop(&mut self) {
        if let Ok(sessions) = self.sessions.lock() {
            for session in sessions.values() {
                if let Ok(mut current) = session.lock() {
                    if ["armed", "capturing", "stopping", "finalizing"]
                        .contains(&current.snapshot.state.as_str())
                    {
                        current.stop = true;
                        current.snapshot.state = "interrupted".into();
                        current.snapshot.error = Some("capture_host_stopped".into());
                        let _ = save(&current);
                    }
                }
            }
        }
        if let Ok(mut workers) = self.workers.lock() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn bounded_text(value: &Value, limit: usize) -> Option<String> {
    let text = value
        .as_str()?
        .chars()
        .filter(|character| !character.is_control())
        .take(limit)
        .collect::<String>();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn result_is_finalizing(session: &Arc<Mutex<Session>>) -> bool {
    session
        .lock()
        .is_ok_and(|value| value.snapshot.state == "finalizing")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_storage::append;
    #[test]
    fn rejects_untrusted_origins_before_creating_files() {
        let root = std::env::temp_dir().join(format!("capture-test-{}", Uuid::new_v4()));
        let manager = CaptureManager::new(root.clone());
        assert!(manager
            .open(&json!({"origin":"https://evil.test"}))
            .is_err());
        assert!(!root.exists());
    }
    #[test]
    fn lists_newest_first_and_deletes_only_finished_sessions() {
        let root = std::env::temp_dir().join(format!("capture-test-{}", Uuid::new_v4()));
        let write = |state: &str, created_at: u64| {
            let id = Uuid::new_v4().to_string();
            let directory = root.join(format!("capture-{id}"));
            fs::create_dir_all(&directory).unwrap();
            let snapshot = Snapshot {
                version: 1,
                id: id.clone(),
                state: state.into(),
                bytes: 0,
                tracks: Vec::new(),
                output: None,
                outputs: Vec::new(),
                error: None,
                created_at,
                page_title: Some("页面".into()),
                page_url: None,
            };
            fs::write(directory.join("capture.json"), serde_json::to_vec(&snapshot).unwrap())
                .unwrap();
            fs::write(directory.join("capture-0.mkv"), b"media").unwrap();
            (id, directory)
        };
        let (older, older_directory) = write("complete", 1);
        let (newer, newer_directory) = write("partial", 2);
        let manager = CaptureManager::new(root.clone());
        let listed = manager.list();
        assert_eq!(listed[0]["id"], newer);
        assert_eq!(listed[1]["id"], older);
        assert_eq!(listed[0]["pageTitle"], "页面");
        manager.delete(&json!({"id":older})).unwrap();
        assert!(!older_directory.exists());
        assert_eq!(manager.list().as_array().unwrap().len(), 1);
        assert_eq!(
            manager.delete(&json!({"id":older})).unwrap_err(),
            "capture_not_found"
        );
        let active = manager.sessions.lock().unwrap()[&newer].clone();
        active.lock().unwrap().worker_active = true;
        assert_eq!(
            manager.delete(&json!({"id":newer})).unwrap_err(),
            "capture_delete_active"
        );
        assert!(newer_directory.exists());
        active.lock().unwrap().worker_active = false;
        drop(manager);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_oversized_metadata_and_missing_sequences() {
        let directory = std::env::temp_dir().join(format!("capture-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let session = Arc::new(Mutex::new(Session {
            directory: directory.clone(),
            stop: false,
            worker_active: false,
            snapshot: Snapshot {
                version: 1,
                id: "test".into(),
                state: "capturing".into(),
                bytes: 0,
                tracks: Vec::new(),
                output: None,
                outputs: Vec::new(),
                error: None,
                created_at: 0,
                page_title: None,
                page_url: None,
            },
        }));
        assert!(append(&session, &[255, 255, 255, 255, 1]).is_err());
        let metadata =
            serde_json::to_vec(&json!({"track":0,"generation":0,"sequence":1,"mime":"video/mp4"}))
                .unwrap();
        let mut frame = (metadata.len() as u32).to_le_bytes().to_vec();
        frame.extend(metadata);
        frame.extend([0, 0, 0, 8, b'f', b't', b'y', b'p']);
        assert!(append(&session, &frame).is_err());
        assert_eq!(session.lock().unwrap().snapshot.bytes, 0);
        fs::remove_dir_all(directory).unwrap();
    }
}
