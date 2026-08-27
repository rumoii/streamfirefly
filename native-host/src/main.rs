use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    thread,
};
use uuid::Uuid;

const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
const STORE_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Task {
    id: String,
    url: String,
    title: String,
    state: String,
    progress: u8,
    output: Option<String>,
    error: Option<String>,
    mime: Option<String>,
}

#[derive(Clone)]
struct Store {
    path: PathBuf,
    tasks: Arc<Mutex<Vec<Task>>>,
}

fn state_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StreamFirefly")
        .join("tasks.json")
}

fn load_store(path: &Path) -> Store {
    let tasks = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| {
            (v["version"].as_u64() == Some(STORE_VERSION.into()))
                .then(|| serde_json::from_value(v["tasks"].clone()).ok())
                .flatten()
        })
        .unwrap_or_default();
    let store = Store {
        path: path.to_path_buf(),
        tasks: Arc::new(Mutex::new(tasks)),
    };
    if let Ok(mut tasks) = store.tasks.lock() {
        for task in tasks.iter_mut() {
            if task.state == "running" || task.state == "queued" {
                task.state = "interrupted".into();
                task.error = Some("native_host_restarted".into());
            }
        }
    }
    save_store(&store);
    store
}

fn save_store(store: &Store) {
    if let Some(parent) = store.path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(tasks) = store.tasks.lock() {
        let data = json!({"version": STORE_VERSION, "tasks": &*tasks});
        let tmp = store.path.with_extension("tmp");
        if fs::write(&tmp, serde_json::to_vec_pretty(&data).unwrap_or_default()).is_ok() {
            let _ = fs::remove_file(&store.path);
            let _ = fs::rename(tmp, &store.path);
        }
    }
}

fn read_message(reader: &mut impl Read) -> io::Result<Value> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length)?;
    let size = u32::from_le_bytes(length) as usize;
    if size == 0 || size > MAX_MESSAGE_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message size",
        ));
    }
    let mut buf = vec![0; size];
    reader.read_exact(&mut buf)?;
    serde_json::from_slice(&buf).map_err(io::Error::other)
}

fn write_message(writer: &mut impl Write, value: &Value) -> io::Result<()> {
    let data = serde_json::to_vec(value).map_err(io::Error::other)?;
    writer.write_all(&(data.len() as u32).to_le_bytes())?;
    writer.write_all(&data)?;
    writer.flush()
}

fn safe_title(value: &str) -> String {
    let value: String = value
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    if value.trim().is_empty() {
        "streamfirefly-download".into()
    } else {
        value
    }
}

fn create_task(store: &Store, payload: &Value) -> Result<Task, &'static str> {
    let url = payload["url"]
        .as_str()
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .ok_or("invalid_url")?;
    let id = Uuid::new_v4().to_string();
    let title = safe_title(
        payload["title"]
            .as_str()
            .unwrap_or("streamfirefly-download"),
    );
    let ext = if payload["mime"].as_str().unwrap_or("").contains("mpegurl") || url.contains(".m3u8")
    {
        "mp4"
    } else {
        "download"
    };
    let output = state_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join("downloads")
        .join(format!("{}-{}.{}", title, &id[..8], ext));
    let task = Task {
        id,
        url: url.into(),
        title,
        state: "queued".into(),
        progress: 0,
        output: Some(output.to_string_lossy().into()),
        error: None,
        mime: payload["mime"].as_str().map(str::to_string),
    };
    store.tasks.lock().unwrap().push(task.clone());
    save_store(store);
    Ok(task)
}

fn update(store: &Store, id: &str, f: impl FnOnce(&mut Task)) {
    if let Ok(mut tasks) = store.tasks.lock() {
        if let Some(task) = tasks.iter_mut().find(|t| t.id == id) {
            f(task);
        }
    }
    save_store(store);
}

fn start_download(store: Store, task: Task) {
    thread::spawn(move || {
        update(&store, &task.id, |t| t.state = "running".into());
        let Some(output) = task.output.as_deref() else {
            update(&store, &task.id, |t| {
                t.state = "failed".into();
                t.error = Some("output_missing".into());
            });
            return;
        };
        if let Some(parent) = Path::new(output).parent() {
            let _ = fs::create_dir_all(parent);
        }
        let is_stream = task.url.to_ascii_lowercase().contains(".m3u8")
            || task.url.to_ascii_lowercase().contains(".mpd")
            || task.mime.as_deref().unwrap_or("").contains("mpegurl")
            || task.mime.as_deref().unwrap_or("").contains("dash+xml");
        let result = if is_stream {
            Command::new("ffmpeg")
                .args([
                    "-nostdin", "-y", "-i", &task.url, "-map", "0:v?", "-map", "0:a?", "-c",
                    "copy", output,
                ])
                .output()
        } else {
            Command::new("curl")
                .args([
                    "--fail",
                    "--location",
                    "--retry",
                    "3",
                    "--retry-all-errors",
                    "--continue-at",
                    "-",
                    "--output",
                    output,
                    &task.url,
                ])
                .output()
        };
        match result {
            Ok(out) if out.status.success() => update(&store, &task.id, |t| {
                t.state = "succeeded".into();
                t.progress = 100;
            }),
            Ok(out) => update(&store, &task.id, |t| {
                t.state = "failed".into();
                t.error = Some(
                    String::from_utf8_lossy(&out.stderr)
                        .chars()
                        .take(500)
                        .collect(),
                );
            }),
            Err(error) => update(&store, &task.id, |t| {
                t.state = "failed".into();
                t.error = Some(error.to_string());
            }),
        }
    });
}

fn main() -> io::Result<()> {
    let store = load_store(&state_path());
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    loop {
        let message = match read_message(&mut input) {
            Ok(value) => value,
            Err(_) => break,
        };
        let id = message["id"].clone();
        let response = match message["type"].as_str().unwrap_or("") {
            "task.create" => match create_task(&store, &message["payload"]) {
                Ok(task) => {
                    start_download(store.clone(), task.clone());
                    json!({"version":1,"id":id,"ok":true,"task":task})
                }
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.list" => {
                json!({"version":1,"id":id,"ok":true,"tasks":store.tasks.lock().unwrap().clone()})
            }
            _ => json!({"version":1,"id":id,"ok":false,"error":"unsupported_message"}),
        };
        write_message(&mut output, &response)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_message_round_trip() {
        let value = json!({"version":1,"id":"a"});
        let mut data = Vec::new();
        write_message(&mut data, &value).unwrap();
        assert_eq!(read_message(&mut data.as_slice()).unwrap(), value);
    }
    #[test]
    fn title_is_safe() {
        assert_eq!(safe_title("a:b"), "a_b");
    }
}
