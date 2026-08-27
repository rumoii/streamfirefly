use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
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
    #[serde(default)]
    phase: String,
    progress: u8,
    #[serde(default)]
    downloaded_bytes: u64,
    #[serde(default)]
    total_bytes: Option<u64>,
    #[serde(default)]
    speed_bytes_per_second: u64,
    #[serde(default)]
    eta_seconds: Option<u64>,
    #[serde(default)]
    attempt: u8,
    #[serde(default)]
    message: Option<String>,
    output: Option<String>,
    error: Option<String>,
    mime: Option<String>,
    #[serde(default)]
    referer: Option<String>,
}

#[derive(Clone)]
struct Store {
    path: PathBuf,
    tasks: Arc<Mutex<Vec<Task>>>,
    processes: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    cancellations: Arc<Mutex<HashMap<String, bool>>>,
}
type Writer = Arc<Mutex<io::BufWriter<io::Stdout>>>;

fn state_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StreamFirefly")
        .join("tasks.json")
}
fn default_download_dir() -> PathBuf {
    state_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join("downloads")
}

fn load_store(path: &Path) -> Store {
    let tasks = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            (v["version"].as_u64() == Some(STORE_VERSION.into()))
                .then(|| serde_json::from_value(v["tasks"].clone()).ok())
                .flatten()
        })
        .unwrap_or_default();
    let store = Store {
        path: path.to_path_buf(),
        tasks: Arc::new(Mutex::new(tasks)),
        processes: Arc::new(Mutex::new(HashMap::new())),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
    };
    if let Ok(mut tasks) = store.tasks.lock() {
        for task in tasks.iter_mut() {
            if matches!(
                task.state.as_str(),
                "running" | "queued" | "starting" | "downloading" | "cancelling"
            ) {
                task.state = "interrupted".into();
                task.phase = "interrupted".into();
                task.error = Some("native_host_restarted".into());
                task.message = Some("本地助手重新启动，任务已中断".into());
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
fn emit(writer: &Writer, value: Value) {
    if let Ok(mut output) = writer.lock() {
        let _ = write_message(&mut *output, &value);
    }
}
fn safe_title(value: &str) -> String {
    safe_file_stem(value).unwrap_or_else(|| "streamfirefly-download".into())
}

fn safe_file_stem(value: &str) -> Option<String> {
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
    let value = value.trim().trim_end_matches([' ', '.']).to_string();
    if value.is_empty() {
        return None;
    }
    let upper = value.to_ascii_uppercase();
    let device = upper.split('.').next().unwrap_or(&upper);
    let reserved = matches!(device, "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0');
    Some(if reserved { format!("_{value}") } else { value })
}

fn extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/mpeg" => Some("mpeg"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/aac" => Some("aac"),
        "audio/ogg" => Some("ogg"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn extension_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?.rsplit('/').next()?;
    let (_, ext) = path.rsplit_once('.')?;
    let ext = ext.trim().to_ascii_lowercase();
    ((1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())).then_some(ext)
}

fn filename_from_content_disposition(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("filename")
            .then(|| value.trim().trim_matches('"').to_string())
    })
}

fn extension_from_content_disposition(value: &str) -> Option<String> {
    extension_from_url(&filename_from_content_disposition(value)?)
}

fn extension_for(payload: &Value) -> String {
    let url = payload["url"].as_str().unwrap_or("");
    let mime = payload["mime"].as_str().unwrap_or("");
    if mime.contains("mpegurl")
        || mime.contains("dash+xml")
        || url.contains(".m3u8")
        || url.contains(".mpd")
    {
        "mp4".into()
    } else if let Some(ext) = payload["contentDisposition"]
        .as_str()
        .and_then(extension_from_content_disposition)
    {
        ext
    } else if let Some(ext) = extension_from_mime(mime) {
        ext.into()
    } else {
        extension_from_url(url).unwrap_or_else(|| "download".into())
    }
}

fn recommended_file_stem(payload: &Value) -> String {
    let disposition = payload["contentDisposition"]
        .as_str()
        .and_then(filename_from_content_disposition)
        .and_then(|name| {
            Path::new(&name)
                .file_stem()
                .map(|value| value.to_string_lossy().into())
        });
    let url_name = payload["url"]
        .as_str()
        .and_then(|url| url.split(['?', '#']).next())
        .and_then(|url| url.rsplit('/').next())
        .and_then(|name| {
            Path::new(name)
                .file_stem()
                .map(|value| value.to_string_lossy().into())
        });
    disposition
        .or(url_name)
        .or_else(|| payload["title"].as_str().map(str::to_string))
        .and_then(|name| safe_file_stem(&name))
        .unwrap_or_else(|| "streamfirefly-download".into())
}

fn prepare_task(payload: &Value) -> Result<Value, &'static str> {
    payload["url"]
        .as_str()
        .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
        .ok_or("invalid_url")?;
    Ok(json!({"fileName": recommended_file_stem(payload), "extension": extension_for(payload)}))
}

fn unique_output_path(dir: &Path, stem: &str, ext: &str, tasks: &[Task]) -> PathBuf {
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = dir.join(format!("{stem}{suffix}.{ext}"));
        let occupied = tasks
            .iter()
            .any(|task| task.output.as_deref().map(Path::new) == Some(candidate.as_path()));
        if !candidate.exists() && !occupied {
            return candidate;
        }
    }
    dir.join(format!("{}-{}.{}", stem, Uuid::new_v4(), ext))
}

fn validate_dir(value: &str) -> Result<PathBuf, &'static str> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("path_empty");
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("path_must_be_absolute");
    }
    if path.exists() {
        if !path.is_dir() {
            return Err("path_is_not_directory");
        }
    } else if fs::create_dir_all(&path).is_err() {
        return Err("path_not_writable");
    }
    let probe = path.join(format!(".streamfirefly-write-{}.tmp", Uuid::new_v4()));
    if OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .is_err()
    {
        return Err("path_not_writable");
    }
    let _ = fs::remove_file(probe);
    Ok(path)
}

fn create_task(store: &Store, payload: &Value) -> Result<Task, &'static str> {
    let url = payload["url"]
        .as_str()
        .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        .ok_or("invalid_url")?;
    let title = safe_title(
        payload["title"]
            .as_str()
            .unwrap_or("streamfirefly-download"),
    );
    let dir = match payload["saveDir"].as_str() {
        Some(value) if !value.trim().is_empty() => validate_dir(value)?,
        _ => {
            let dir = default_download_dir();
            fs::create_dir_all(&dir).map_err(|_| "path_not_writable")?;
            dir
        }
    };
    let id = Uuid::new_v4().to_string();
    let ext = extension_for(payload);
    let custom_name = match payload["fileName"].as_str() {
        Some(raw) => safe_file_stem(raw).ok_or("invalid_file_name")?,
        None => String::new(),
    };
    let mut tasks = store.tasks.lock().unwrap();
    let output = if payload["fileName"].is_string() {
        unique_output_path(&dir, &custom_name, &ext, &tasks)
    } else {
        dir.join(format!("{}-{}.{}", title, &id[..8], ext))
    };
    let display_title = if custom_name.is_empty() {
        title
    } else {
        custom_name
    };
    let task = Task {
        id,
        url: url.into(),
        title: display_title,
        state: "queued".into(),
        phase: "queued".into(),
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: None,
        speed_bytes_per_second: 0,
        eta_seconds: None,
        attempt: 1,
        message: Some("等待下载".into()),
        output: Some(output.to_string_lossy().into()),
        error: None,
        mime: payload["mime"].as_str().map(str::to_string),
        referer: payload["referer"].as_str().map(str::to_string),
    };
    tasks.push(task.clone());
    drop(tasks);
    save_store(store);
    Ok(task)
}

fn update(store: &Store, writer: &Writer, id: &str, f: impl FnOnce(&mut Task)) {
    let changed = if let Ok(mut tasks) = store.tasks.lock() {
        if let Some(task) = tasks.iter_mut().find(|t| t.id == id) {
            f(task);
            Some(task.clone())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(task) = changed {
        save_store(store);
        emit(
            writer,
            json!({"version":1,"type":"task.progress","task":task}),
        );
    }
}

fn register_process(store: &Store, id: &str, child: Child) -> Arc<Mutex<Child>> {
    let child = Arc::new(Mutex::new(child));
    store
        .processes
        .lock()
        .unwrap()
        .insert(id.into(), child.clone());
    child
}

fn unregister_process(store: &Store, id: &str) {
    store.processes.lock().unwrap().remove(id);
}

fn clear_cancellation(store: &Store, id: &str) {
    store.cancellations.lock().unwrap().remove(id);
}

fn cancel_requested(store: &Store, id: &str) -> bool {
    store.cancellations.lock().unwrap().contains_key(id)
}

fn mark_cancelled(store: &Store, writer: &Writer, id: &str) {
    unregister_process(store, id);
    update(store, writer, id, |task| {
        task.state = "cancelled".into();
        task.phase = "cancelled".into();
        task.speed_bytes_per_second = 0;
        task.eta_seconds = None;
        task.error = None;
        task.message = Some("下载已取消".into());
    });
    clear_cancellation(store, id);
}

fn stop_process(store: &Store, id: &str) {
    let process = store.processes.lock().unwrap().get(id).cloned();
    if let Some(process) = process {
        if let Ok(mut child) = process.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn delete_output(path: &str) -> Result<bool, &'static str> {
    let path = Path::new(path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("file_delete_failed"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("file_delete_unsafe");
    }
    fs::remove_file(path).map_err(|_| "file_delete_failed")?;
    Ok(true)
}

fn delete_task(store: &Store, writer: &Writer, payload: &Value) -> Result<Value, &'static str> {
    let id = payload["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("task_id_empty")?;
    let delete_file = payload["deleteFile"].as_bool().unwrap_or(false);
    let task = store
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .ok_or("task_not_found")?;
    if matches!(
        task.state.as_str(),
        "queued" | "starting" | "running" | "cancelling"
    ) {
        update(store, writer, id, |task| {
            task.state = "cancelling".into();
            task.phase = "cancelling".into();
            task.message = Some("正在取消下载".into());
        });
        store.cancellations.lock().unwrap().insert(id.into(), true);
        stop_process(store, id);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let terminal = store
                .tasks
                .lock()
                .unwrap()
                .iter()
                .find(|item| item.id == id)
                .map(|item| {
                    matches!(
                        item.state.as_str(),
                        "cancelled" | "succeeded" | "failed" | "interrupted"
                    )
                })
                .unwrap_or(true);
            if terminal || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let cancelled = store
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .map(|item| {
                matches!(
                    item.state.as_str(),
                    "cancelled" | "succeeded" | "failed" | "interrupted"
                )
            })
            .unwrap_or(false);
        if !cancelled {
            clear_cancellation(store, id);
            update(store, writer, id, |task| {
                task.state = "failed".into();
                task.phase = "failed".into();
                task.error = Some("cancel_failed".into());
                task.message = Some("取消下载失败，任务和文件均已保留".into());
            });
            return Err("cancel_failed");
        }
    }
    let file_deleted = if delete_file {
        match task.output.as_deref() {
            Some(path) => delete_output(path)?,
            None => false,
        }
    } else {
        false
    };
    let removed = {
        let mut tasks = store.tasks.lock().unwrap();
        let before = tasks.len();
        tasks.retain(|item| item.id != id);
        tasks.len() != before
    };
    if !removed {
        return Err("task_not_found");
    }
    clear_cancellation(store, id);
    save_store(store);
    emit(writer, json!({"version":1,"type":"task.deleted","id":id}));
    Ok(
        json!({"id": id, "fileDeleted": file_deleted, "fileKept": !delete_file && task.output.is_some()}),
    )
}

fn probe_size(store: &Store, writer: &Writer, task: &Task) -> Option<u64> {
    let mut command = Command::new("curl");
    command
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
            "--head",
            &task.url,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = register_process(store, &task.id, command.spawn().ok()?);
    loop {
        if cancel_requested(store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            mark_cancelled(store, writer, &task.id);
            return None;
        }
        let finished = child.lock().ok()?.try_wait().ok()?;
        if let Some(status) = finished {
            let mut bytes = Vec::new();
            if let Ok(mut child) = child.lock() {
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_end(&mut bytes);
                }
            }
            unregister_process(store, &task.id);
            if !status.success() {
                return None;
            }
            let output = String::from_utf8_lossy(&bytes);
            return output.lines().rev().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name.trim().eq_ignore_ascii_case("content-length"))
                    .then(|| value.trim().parse().ok())
                    .flatten()
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn start_http_download(store: Store, writer: Writer, task: Task, output: String) {
    let total = probe_size(&store, &writer, &task);
    if cancel_requested(&store, &task.id) {
        mark_cancelled(&store, &writer, &task.id);
        return;
    }
    update(&store, &writer, &task.id, |t| {
        t.state = "starting".into();
        t.phase = "starting".into();
        t.total_bytes = total;
        t.message = Some("正在连接资源".into());
    });
    let mut args = vec![
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--retry",
        "3",
        "--retry-all-errors",
        "--continue-at",
        "-",
        "--output",
        &output,
    ];
    if let Some(referer) = task.referer.as_deref() {
        args.extend(["--referer", referer]);
    }
    args.push(&task.url);
    let child = match Command::new("curl")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            update(&store, &writer, &task.id, |t| {
                t.state = "failed".into();
                t.phase = "failed".into();
                t.error = Some(error.to_string());
                t.message = Some("无法启动下载程序".into());
            });
            return;
        }
    };
    let child = register_process(&store, &task.id, child);
    let mut sampled_at = Instant::now();
    let mut smoothed_speed = 0u64;
    let mut last_bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    update(&store, &writer, &task.id, |t| {
        t.state = "running".into();
        t.phase = "downloading".into();
        t.downloaded_bytes = last_bytes;
        t.message = Some("正在下载".into());
    });
    loop {
        thread::sleep(Duration::from_millis(500));
        if cancel_requested(&store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            mark_cancelled(&store, &writer, &task.id);
            return;
        }
        let bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(last_bytes);
        let sample_seconds = sampled_at.elapsed().as_secs_f64().max(0.001);
        let sampled_speed = (bytes.saturating_sub(last_bytes)) as f64 / sample_seconds;
        if sampled_speed > 0.0 {
            smoothed_speed = if smoothed_speed == 0 {
                sampled_speed as u64
            } else {
                (smoothed_speed as f64 * 0.6 + sampled_speed * 0.4) as u64
            };
        }
        sampled_at = Instant::now();
        last_bytes = bytes;
        let percent = total
            .map(|size| {
                if size == 0 {
                    0
                } else {
                    ((bytes.saturating_mul(100) / size).min(99)) as u8
                }
            })
            .unwrap_or(0);
        let eta = total.and_then(|size| {
            (smoothed_speed > 0).then(|| size.saturating_sub(bytes) / smoothed_speed)
        });
        update(&store, &writer, &task.id, |t| {
            if !matches!(
                t.state.as_str(),
                "succeeded" | "failed" | "cancelled" | "interrupted"
            ) {
                t.state = "running".into();
                t.phase = "downloading".into();
                t.progress = percent;
                t.downloaded_bytes = bytes;
                t.total_bytes = total;
                t.speed_bytes_per_second = smoothed_speed;
                t.eta_seconds = eta;
            }
        });
        let process_status = child
            .lock()
            .map_err(|_| io::Error::other("process_lock_poisoned"))
            .and_then(|mut child| child.try_wait());
        match process_status {
            Ok(Some(status)) => {
                unregister_process(&store, &task.id);
                if cancel_requested(&store, &task.id) {
                    mark_cancelled(&store, &writer, &task.id);
                    return;
                }
                if status.success() {
                    update(&store, &writer, &task.id, |t| {
                        t.state = "succeeded".into();
                        t.phase = "completed".into();
                        t.progress = 100;
                        t.downloaded_bytes =
                            fs::metadata(&output).map(|m| m.len()).unwrap_or(bytes);
                        t.total_bytes = total.or(Some(t.downloaded_bytes));
                        t.eta_seconds = Some(0);
                        t.message = Some("下载完成".into());
                    });
                } else {
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some("curl_download_failed".into());
                        t.message = Some("下载失败，请检查网络或资源地址".into());
                    });
                }
                break;
            }
            Err(error) => {
                unregister_process(&store, &task.id);
                update(&store, &writer, &task.id, |t| {
                    t.state = "failed".into();
                    t.phase = "failed".into();
                    t.error = Some(error.to_string());
                });
                break;
            }
            Ok(None) => {}
        }
    }
}

fn start_download(store: Store, writer: Writer, task: Task) {
    thread::spawn(move || {
        if cancel_requested(&store, &task.id) {
            mark_cancelled(&store, &writer, &task.id);
            return;
        }
        let Some(output) = task.output.clone() else {
            update(&store, &writer, &task.id, |t| {
                t.state = "failed".into();
                t.phase = "failed".into();
                t.error = Some("output_missing".into());
            });
            return;
        };
        if let Some(parent) = Path::new(&output).parent() {
            let _ = fs::create_dir_all(parent);
        }
        let is_stream = task.url.to_ascii_lowercase().contains(".m3u8")
            || task.url.to_ascii_lowercase().contains(".mpd")
            || task.mime.as_deref().unwrap_or("").contains("mpegurl")
            || task.mime.as_deref().unwrap_or("").contains("dash+xml");
        if !is_stream {
            start_http_download(store, writer, task, output);
            return;
        }
        update(&store, &writer, &task.id, |t| {
            t.state = "running".into();
            t.phase = "fetching".into();
            t.message = Some("正在读取流媒体清单，需要 FFmpeg".into());
        });
        let child = match Command::new("ffmpeg")
            .args([
                "-nostdin",
                "-y",
                "-loglevel",
                "error",
                "-i",
                &task.url,
                "-map",
                "0:v?",
                "-map",
                "0:a?",
                "-c",
                "copy",
                &output,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) => {
                update(&store, &writer, &task.id, |t| {
                    t.state = "failed".into();
                    t.phase = "failed".into();
                    t.error = Some(error.to_string());
                    t.message = Some("未找到 FFmpeg".into());
                });
                return;
            }
        };
        let child = register_process(&store, &task.id, child);
        let mut last_bytes = 0u64;
        let mut sampled_at = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(500));
            if cancel_requested(&store, &task.id) {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                mark_cancelled(&store, &writer, &task.id);
                return;
            }
            let bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(last_bytes);
            let speed = (bytes.saturating_sub(last_bytes) as f64
                / sampled_at.elapsed().as_secs_f64().max(0.001)) as u64;
            last_bytes = bytes;
            sampled_at = Instant::now();
            update(&store, &writer, &task.id, |t| {
                t.state = "running".into();
                t.phase = "merging".into();
                t.downloaded_bytes = bytes;
                t.speed_bytes_per_second = speed;
                t.message = Some("正在下载流媒体分片并合并".into());
            });
            let process_status = child
                .lock()
                .map_err(|_| io::Error::other("process_lock_poisoned"))
                .and_then(|mut child| child.try_wait());
            match process_status {
                Ok(Some(status)) if status.success() => {
                    unregister_process(&store, &task.id);
                    if cancel_requested(&store, &task.id) {
                        mark_cancelled(&store, &writer, &task.id);
                        return;
                    }
                    update(&store, &writer, &task.id, |t| {
                        t.state = "succeeded".into();
                        t.phase = "completed".into();
                        t.progress = 100;
                        t.downloaded_bytes =
                            fs::metadata(&output).map(|m| m.len()).unwrap_or(bytes);
                        t.total_bytes = Some(t.downloaded_bytes);
                        t.message = Some("流媒体下载完成".into());
                    });
                    break;
                }
                Ok(Some(_)) => {
                    unregister_process(&store, &task.id);
                    if cancel_requested(&store, &task.id) {
                        mark_cancelled(&store, &writer, &task.id);
                        return;
                    }
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some("ffmpeg_unavailable_or_failed".into());
                        t.message = Some("FFmpeg 无法处理此资源".into());
                    });
                    break;
                }
                Err(error) => {
                    unregister_process(&store, &task.id);
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some(error.to_string());
                    });
                    break;
                }
                Ok(None) => {}
            }
        }
    });
}

fn main() -> io::Result<()> {
    let store = load_store(&state_path());
    let writer: Writer = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut input = io::stdin().lock();
    loop {
        let message = match read_message(&mut input) {
            Ok(value) => value,
            Err(_) => break,
        };
        let id = message["id"].clone();
        let response = match message["type"].as_str().unwrap_or("") {
            "task.create" => match create_task(&store, &message["payload"]) {
                Ok(task) => {
                    start_download(store.clone(), writer.clone(), task.clone());
                    json!({"version":1,"id":id,"ok":true,"task":task})
                }
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.prepare" => match prepare_task(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"payload":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.delete" => match delete_task(&store, &writer, &message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"payload":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.list" => {
                json!({"version":1,"id":id,"ok":true,"tasks":store.tasks.lock().unwrap().clone()})
            }
            "path.validate" => match message["payload"]["path"]
                .as_str()
                .ok_or("path_empty")
                .and_then(validate_dir)
            {
                Ok(path) => json!({"version":1,"id":id,"ok":true,"path":path.to_string_lossy()}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            _ => json!({"version":1,"id":id,"ok":false,"error":"unsupported_message"}),
        };
        emit(&writer, response);
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
        assert_eq!(safe_file_stem("  测试视频. "), Some("测试视频".into()));
        assert_eq!(safe_file_stem("CON"), Some("_CON".into()));
        assert_eq!(safe_file_stem("con.txt"), Some("_con.txt".into()));
        assert_eq!(safe_file_stem("..."), None);
    }
    #[test]
    fn relative_path_is_rejected() {
        assert_eq!(validate_dir("downloads"), Err("path_must_be_absolute"));
    }
    #[test]
    fn old_task_json_uses_progress_defaults() {
        let task: Task = serde_json::from_value(json!({
            "id":"old","url":"https://example.test/a.mp4","title":"old",
            "state":"succeeded","progress":100,"output":null,"error":null,"mime":"video/mp4"
        }))
        .unwrap();
        assert_eq!(task.phase, "");
        assert_eq!(task.downloaded_bytes, 0);
        assert_eq!(task.total_bytes, None);
    }
    #[test]
    fn file_path_is_rejected() {
        let path = std::env::temp_dir().join(format!("streamfirefly-file-{}", Uuid::new_v4()));
        fs::write(&path, b"test").unwrap();
        assert_eq!(
            validate_dir(path.to_string_lossy().as_ref()),
            Err("path_is_not_directory")
        );
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn file_extension_prefers_disposition_then_mime_then_url() {
        assert_eq!(
            extension_from_content_disposition("attachment; filename=movie.webm"),
            Some("webm".into())
        );
        assert_eq!(extension_from_mime("video/mp4"), Some("mp4"));
        assert_eq!(
            extension_from_url("https://example.test/video/sample.m4a?token=1"),
            Some("m4a".into())
        );
    }
    #[test]
    fn task_prepare_uses_disposition_name_and_detected_extension() {
        let prepared = prepare_task(&json!({
            "url":"https://example.test/fallback.bin",
            "title":"页面标题",
            "mime":"video/mp4",
            "contentDisposition":"attachment; filename=movie.webm"
        }))
        .unwrap();
        assert_eq!(prepared["fileName"], "movie");
        assert_eq!(prepared["extension"], "webm");
    }
    #[test]
    fn unique_output_adds_sequence_for_existing_and_reserved_names() {
        let dir = std::env::temp_dir().join(format!("streamfirefly-name-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("视频.mp4"), b"existing").unwrap();
        let tasks = vec![Task {
            id: "reserved".into(),
            url: "https://example.test/a.mp4".into(),
            title: "reserved".into(),
            state: "queued".into(),
            phase: "queued".into(),
            progress: 0,
            downloaded_bytes: 0,
            total_bytes: None,
            speed_bytes_per_second: 0,
            eta_seconds: None,
            attempt: 1,
            message: None,
            output: Some(dir.join("视频 (1).mp4").to_string_lossy().into()),
            error: None,
            mime: Some("video/mp4".into()),
            referer: None,
        }];
        assert_eq!(
            unique_output_path(&dir, "视频", "mp4", &tasks),
            dir.join("视频 (2).mp4")
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn delete_output_rejects_directories_and_accepts_missing_files() {
        let dir = std::env::temp_dir().join(format!("streamfirefly-delete-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            delete_output(dir.to_string_lossy().as_ref()),
            Err("file_delete_unsafe")
        );
        assert_eq!(
            delete_output(dir.join("missing.mp4").to_string_lossy().as_ref()),
            Ok(false)
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
