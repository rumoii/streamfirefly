use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime},
};
use uuid::Uuid;

const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
const STORE_VERSION: u8 = 1;
const DEFAULT_DOWNLOAD_THREADS: u8 = 6;
const MAX_DOWNLOAD_THREADS: u8 = 16;
const INLINE_MANIFEST_MAX_BYTES: usize = 512 * 1024;
const SENSITIVE_REQUEST_HEADERS: [&str; 2] = ["cookie", "authorization"];

#[derive(Debug, Clone)]
struct InlineManifest {
    text: String,
    base_url: String,
}

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
    #[serde(default = "default_download_threads")]
    download_threads: u8,
    #[serde(default)]
    request_headers: HashMap<String, String>,
    #[serde(default)]
    active_connections: u8,
    #[serde(default)]
    segments_completed: u32,
    #[serde(default)]
    segments_total: u32,
    #[serde(skip)]
    inline_manifest: Option<InlineManifest>,
}

struct TempManifestFile(PathBuf);

impl TempManifestFile {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempManifestFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Clone)]
struct Store {
    path: PathBuf,
    tasks: Arc<Mutex<Vec<Task>>>,
    processes: Arc<Mutex<HashMap<String, Vec<Arc<Mutex<Child>>>>>>,
    cancellations: Arc<Mutex<HashMap<String, bool>>>,
    pauses: Arc<Mutex<HashSet<String>>>,
}
type Writer = Arc<Mutex<io::BufWriter<io::Stdout>>>;

fn default_download_threads() -> u8 {
    DEFAULT_DOWNLOAD_THREADS
}

fn download_threads(value: &Value) -> u8 {
    value["downloadThreads"]
        .as_u64()
        .map(|value| value.clamp(1, MAX_DOWNLOAD_THREADS as u64) as u8)
        .unwrap_or(DEFAULT_DOWNLOAD_THREADS)
}

fn state_path() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("StreamFirefly")
        .join("tasks.json")
}
fn inline_manifest_dir() -> PathBuf {
    std::env::temp_dir().join("StreamFirefly").join("manifests")
}

fn cleanup_stale_inline_manifests() {
    let dir = inline_manifest_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let stale = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age >= Duration::from_secs(24 * 60 * 60));
        if stale
            && path.is_file()
            && path.extension().and_then(|value| value.to_str()) == Some("m3u8")
        {
            let _ = fs::remove_file(path);
        }
    }
}
fn default_download_dir() -> PathBuf {
    state_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join("downloads")
}

fn load_store(path: &Path) -> Store {
    let mut tasks: Vec<Task> = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            (v["version"].as_u64() == Some(STORE_VERSION.into()))
                .then(|| serde_json::from_value(v["tasks"].clone()).ok())
                .flatten()
        })
        .unwrap_or_default();
    // Credentials are intentionally valid only for the process that captured them.
    // This also scrubs task files written by versions that persisted sensitive headers.
    for task in &mut tasks {
        let had_credentials = task
            .request_headers
            .keys()
            .any(|name| is_sensitive_request_header(name));
        strip_sensitive_headers(task);
        if matches!(
            task.state.as_str(),
            "running"
                | "queued"
                | "starting"
                | "downloading"
                | "retrying"
                | "pausing"
                | "cancelling"
        ) {
            task.state = "interrupted".into();
            task.phase = "interrupted".into();
            task.error = Some("native_host_restarted".into());
            task.message = Some(if had_credentials {
                "登录凭据未持久化，请从页面重新发起下载".into()
            } else {
                "本地助手重新启动，任务已中断".into()
            });
        }
    }
    let store = Store {
        path: path.to_path_buf(),
        tasks: Arc::new(Mutex::new(tasks)),
        processes: Arc::new(Mutex::new(HashMap::new())),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
        pauses: Arc::new(Mutex::new(HashSet::new())),
    };
    save_store(&store);
    store
}

fn save_store(store: &Store) {
    if let Some(parent) = store.path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(tasks) = store.tasks.lock() {
        let persisted_tasks: Vec<Task> = tasks.iter().map(sanitized_task).collect();
        let data = json!({"version": STORE_VERSION, "tasks": persisted_tasks});
        let tmp = store.path.with_extension("tmp");
        if fs::write(&tmp, serde_json::to_vec_pretty(&data).unwrap_or_default()).is_ok() {
            let _ = fs::remove_file(&store.path);
            let _ = fs::rename(tmp, &store.path);
        }
    }
}

fn is_sensitive_request_header(name: &str) -> bool {
    SENSITIVE_REQUEST_HEADERS
        .iter()
        .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
}

fn strip_sensitive_headers(task: &mut Task) {
    task.request_headers
        .retain(|name, _| !is_sensitive_request_header(name));
}

fn sanitized_task(task: &Task) -> Task {
    let mut copy = task.clone();
    strip_sensitive_headers(&mut copy);
    copy.inline_manifest = None;
    copy
}

fn sanitized_tasks(tasks: &[Task]) -> Vec<Task> {
    tasks.iter().map(sanitized_task).collect()
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

fn is_network_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

fn validate_manifest_uri(value: &str) -> Result<(), &'static str> {
    is_network_url(value.trim())
        .then_some(())
        .ok_or("inline_manifest_unsafe_uri")
}

fn validate_manifest_line(line: &str) -> Result<(), &'static str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if !trimmed.starts_with('#') {
        return validate_manifest_uri(trimmed);
    }
    let lower = trimmed.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative) = lower[offset..].find("uri=") {
        let value_start = offset + relative + 4;
        let quote = trimmed.as_bytes().get(value_start).copied();
        if !matches!(quote, Some(b'\"' | b'\'')) {
            return Err("inline_manifest_unsafe_uri");
        }
        let quote = quote.unwrap();
        let rest = &trimmed.as_bytes()[value_start + 1..];
        let Some(length) = rest.iter().position(|value| *value == quote) else {
            return Err("inline_manifest_invalid");
        };
        let value_end = value_start + 1 + length;
        validate_manifest_uri(&trimmed[value_start + 1..value_end])?;
        offset = value_end + 1;
    }
    Ok(())
}

fn inline_manifest(payload: &Value) -> Result<Option<InlineManifest>, &'static str> {
    let Some(value) = payload
        .get("inlineManifest")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    if value["format"].as_str() != Some("hls") {
        return Err("inline_manifest_invalid");
    }
    let text = value["text"].as_str().ok_or("inline_manifest_invalid")?;
    if text.is_empty() || text.len() > INLINE_MANIFEST_MAX_BYTES {
        return Err("inline_manifest_too_large");
    }
    if text.lines().next().map(str::trim) != Some("#EXTM3U") || text.contains('\0') {
        return Err("inline_manifest_invalid");
    }
    let base_url = value["baseUrl"]
        .as_str()
        .filter(|url| is_network_url(url))
        .ok_or("inline_manifest_invalid")?;
    for line in text.lines() {
        validate_manifest_line(line)?;
    }
    Ok(Some(InlineManifest {
        text: text.into(),
        base_url: base_url.into(),
    }))
}

fn write_inline_manifest(task_id: &str, manifest: &InlineManifest) -> io::Result<TempManifestFile> {
    let dir = inline_manifest_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{task_id}.m3u8"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    if let Err(error) = file
        .write_all(manifest.text.as_bytes())
        .and_then(|_| file.flush())
    {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(error);
    }
    Ok(TempManifestFile(path))
}

fn extension_for(payload: &Value) -> String {
    let url = payload["url"].as_str().unwrap_or("");
    let mime = payload["mime"].as_str().unwrap_or("");
    if payload
        .get("inlineManifest")
        .is_some_and(|value| !value.is_null())
        || mime.contains("mpegurl")
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
    let title = payload["title"].as_str().map(str::to_string);
    disposition
        .or_else(|| {
            payload
                .get("inlineManifest")
                .filter(|value| !value.is_null())
                .and(title.clone())
        })
        .or(url_name)
        .or(title)
        .and_then(|name| safe_file_stem(&name))
        .unwrap_or_else(|| "streamfirefly-download".into())
}

fn prepare_task(payload: &Value) -> Result<Value, &'static str> {
    let manifest = inline_manifest(payload)?;
    if manifest.is_none() {
        payload["url"]
            .as_str()
            .filter(|url| is_network_url(url))
            .ok_or("invalid_url")?;
    }
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

fn allowed_request_headers(payload: &Value) -> HashMap<String, String> {
    let allowed = ["referer", "origin", "authorization", "cookie", "user-agent"];
    let mut headers = HashMap::new();
    if let Some(values) = payload["requestHeaders"].as_object() {
        for (name, value) in values {
            let key = name.to_ascii_lowercase();
            if allowed.contains(&key.as_str()) {
                if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                    headers.insert(key, value.to_string());
                }
            }
        }
    }
    if !headers.contains_key("referer") {
        if let Some(referer) = payload["referer"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            headers.insert("referer".into(), referer.into());
        }
    }
    headers
}

fn create_task(store: &Store, payload: &Value) -> Result<Task, &'static str> {
    let inline_manifest = inline_manifest(payload)?;
    let url = payload["url"]
        .as_str()
        .filter(|url| is_network_url(url))
        .or_else(|| {
            inline_manifest
                .as_ref()
                .map(|manifest| manifest.base_url.as_str())
        })
        .ok_or("invalid_url")?
        .to_string();
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
    let mut request_headers = allowed_request_headers(payload);
    if inline_manifest.is_some() {
        request_headers.retain(|name, _| !is_sensitive_request_header(name));
    }
    let task = Task {
        id,
        url,
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
        download_threads: download_threads(payload),
        request_headers,
        active_connections: 0,
        segments_completed: 0,
        segments_total: 0,
        inline_manifest,
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
        let public_task = sanitized_task(&task);
        emit(
            writer,
            json!({"version":1,"type":"task.progress","task":public_task}),
        );
    }
}

fn register_process(store: &Store, id: &str, child: Child) -> Arc<Mutex<Child>> {
    let child = Arc::new(Mutex::new(child));
    store
        .processes
        .lock()
        .unwrap()
        .entry(id.into())
        .or_default()
        .push(child.clone());
    child
}

fn unregister_process(store: &Store, id: &str, process: &Arc<Mutex<Child>>) {
    let mut processes = store.processes.lock().unwrap();
    if let Some(items) = processes.get_mut(id) {
        items.retain(|item| !Arc::ptr_eq(item, process));
        if items.is_empty() {
            processes.remove(id);
        }
    }
}

fn unregister_all_processes(store: &Store, id: &str) {
    store.processes.lock().unwrap().remove(id);
}

fn clear_cancellation(store: &Store, id: &str) {
    store.cancellations.lock().unwrap().remove(id);
}

fn clear_pause(store: &Store, id: &str) {
    store.pauses.lock().unwrap().remove(id);
}

fn pause_requested(store: &Store, id: &str) -> bool {
    store.pauses.lock().unwrap().contains(id)
}

fn cancel_requested(store: &Store, id: &str) -> bool {
    store.cancellations.lock().unwrap().contains_key(id)
}

fn mark_stopped(store: &Store, writer: &Writer, id: &str) {
    unregister_all_processes(store, id);
    let paused = pause_requested(store, id);
    update(store, writer, id, |task| {
        task.state = if paused { "paused" } else { "cancelled" }.into();
        task.phase = if paused { "paused" } else { "cancelled" }.into();
        task.speed_bytes_per_second = 0;
        task.eta_seconds = None;
        task.active_connections = 0;
        task.error = None;
        task.message = Some(
            if paused {
                "下载已暂停"
            } else {
                "下载已取消"
            }
            .into(),
        );
    });
    clear_cancellation(store, id);
    clear_pause(store, id);
}

fn stop_process(store: &Store, id: &str) {
    let processes = store
        .processes
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .unwrap_or_default();
    for process in processes {
        if let Ok(mut child) = process.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn wait_for_state(store: &Store, id: &str, expected: &[&str], deadline: Instant) -> bool {
    loop {
        let reached = store
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .map(|item| expected.contains(&item.state.as_str()))
            .unwrap_or(false);
        if reached || Instant::now() >= deadline {
            return reached;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn task_control(store: &Store, writer: &Writer, payload: &Value) -> Result<Task, &'static str> {
    let id = payload["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("task_id_empty")?;
    let action = payload["action"].as_str().ok_or("task_action_empty")?;
    let task = store
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .ok_or("task_not_found")?;
    match action {
        "pause" => {
            if task.state == "paused" {
                return Ok(sanitized_task(&task));
            }
            if !matches!(
                task.state.as_str(),
                "queued" | "starting" | "running" | "retrying"
            ) {
                return Err("task_not_pauseable");
            }
            store.pauses.lock().unwrap().insert(id.into());
            store.cancellations.lock().unwrap().insert(id.into(), true);
            update(store, writer, id, |task| {
                task.state = "pausing".into();
                task.phase = "pausing".into();
                task.message = Some("正在暂停下载".into());
            });
            stop_process(store, id);
            if !wait_for_state(
                store,
                id,
                &["paused"],
                Instant::now() + Duration::from_secs(5),
            ) {
                clear_pause(store, id);
                clear_cancellation(store, id);
                return Err("pause_failed");
            }
        }
        "cancel" => {
            if task.state == "cancelled" {
                return Ok(sanitized_task(&task));
            }
            if !matches!(
                task.state.as_str(),
                "queued" | "starting" | "running" | "retrying" | "pausing" | "paused"
            ) {
                return Err("task_not_cancellable");
            }
            clear_pause(store, id);
            store.cancellations.lock().unwrap().insert(id.into(), true);
            update(store, writer, id, |task| {
                task.state = "cancelling".into();
                task.phase = "cancelling".into();
                task.message = Some("正在取消下载".into());
            });
            stop_process(store, id);
            if task.state == "paused" {
                mark_stopped(store, writer, id);
            }
            if !wait_for_state(
                store,
                id,
                &["cancelled"],
                Instant::now() + Duration::from_secs(5),
            ) {
                clear_cancellation(store, id);
                return Err("cancel_failed");
            }
        }
        "resume" | "retry" => {
            let allowed = if action == "resume" {
                matches!(task.state.as_str(), "paused" | "interrupted")
            } else {
                matches!(
                    task.state.as_str(),
                    "failed" | "cancelled" | "interrupted" | "paused"
                )
            };
            if !allowed {
                return Err(if action == "resume" {
                    "task_not_resumable"
                } else {
                    "task_not_retryable"
                });
            }
            clear_pause(store, id);
            clear_cancellation(store, id);
            update(store, writer, id, |task| {
                task.state = "retrying".into();
                task.phase = "retrying".into();
                task.attempt = task.attempt.saturating_add(1);
                task.error = None;
                task.speed_bytes_per_second = 0;
                task.eta_seconds = None;
                task.message = Some(
                    if action == "resume" {
                        "正在恢复下载"
                    } else {
                        "正在重新下载"
                    }
                    .into(),
                );
            });
            let restarted = store
                .tasks
                .lock()
                .unwrap()
                .iter()
                .find(|task| task.id == id)
                .cloned()
                .ok_or("task_not_found")?;
            start_download(store.clone(), writer.clone(), restarted);
        }
        _ => return Err("task_action_unsupported"),
    }
    store
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .map(sanitized_task)
        .ok_or("task_not_found")
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
        "queued" | "starting" | "running" | "retrying" | "pausing" | "cancelling"
    ) {
        clear_pause(store, id);
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
    clear_pause(store, id);
    save_store(store);
    emit(writer, json!({"version":1,"type":"task.deleted","id":id}));
    Ok(
        json!({"id": id, "fileDeleted": file_deleted, "fileKept": !delete_file && task.output.is_some()}),
    )
}

#[derive(Default, Clone, Copy)]
struct ProbeInfo {
    total: Option<u64>,
    accept_ranges: bool,
    cancelled: bool,
}

fn add_header_args(args: &mut Vec<String>, task: &Task) {
    for (name, value) in &task.request_headers {
        args.push("--header".into());
        args.push(format!("{name}: {value}"));
    }
}

fn probe_size(store: &Store, task: &Task) -> ProbeInfo {
    let mut command = Command::new("curl");
    let mut args: Vec<String> = [
        "--silent",
        "--show-error",
        "--fail",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "20",
        "--head",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    add_header_args(&mut args, task);
    args.push(task.url.clone());
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = match command.spawn() {
        Ok(child) => register_process(store, &task.id, child),
        Err(_) => return ProbeInfo::default(),
    };
    loop {
        if cancel_requested(store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            unregister_process(store, &task.id, &child);
            return ProbeInfo {
                cancelled: true,
                ..ProbeInfo::default()
            };
        }
        let finished = match child.lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(status) => status,
                Err(_) => return ProbeInfo::default(),
            },
            Err(_) => return ProbeInfo::default(),
        };
        if let Some(status) = finished {
            let mut bytes = Vec::new();
            if let Ok(mut child) = child.lock() {
                if let Some(mut stdout) = child.stdout.take() {
                    let _ = stdout.read_to_end(&mut bytes);
                }
            }
            unregister_process(store, &task.id, &child);
            if !status.success() {
                return ProbeInfo::default();
            }
            let output = String::from_utf8_lossy(&bytes);
            let total = output.lines().rev().find_map(|line| {
                let (name, value) = line.split_once(':')?;
                (name.trim().eq_ignore_ascii_case("content-length"))
                    .then(|| value.trim().parse().ok())
                    .flatten()
            });
            let accept_ranges = output.lines().any(|line| {
                line.split_once(':')
                    .map(|(name, value)| {
                        name.trim().eq_ignore_ascii_case("accept-ranges")
                            && value.trim().eq_ignore_ascii_case("bytes")
                    })
                    .unwrap_or(false)
            });
            return ProbeInfo {
                total,
                accept_ranges,
                cancelled: false,
            };
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn start_single_http_download(
    store: Store,
    writer: Writer,
    task: Task,
    output: String,
    total: Option<u64>,
) {
    update(&store, &writer, &task.id, |t| {
        t.state = "starting".into();
        t.phase = "starting".into();
        t.total_bytes = total;
        t.active_connections = 0;
        t.segments_completed = 0;
        t.segments_total = 0;
        t.message = Some("正在连接资源".into());
    });
    let mut args = vec![
        "--silent".into(),
        "--show-error".into(),
        "--fail".into(),
        "--location".into(),
        "--retry".into(),
        "3".into(),
        "--retry-all-errors".into(),
        "--continue-at".into(),
        "-".into(),
        "--output".into(),
        output.clone(),
    ];
    add_header_args(&mut args, &task);
    args.push(task.url.clone());
    let child = match Command::new("curl")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => register_process(&store, &task.id, child),
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
    let mut sampled_at = Instant::now();
    let mut smoothed_speed = 0u64;
    let mut last_bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(0);
    update(&store, &writer, &task.id, |t| {
        t.state = "running".into();
        t.phase = "downloading".into();
        t.downloaded_bytes = last_bytes;
        t.active_connections = 1;
        t.message = Some("正在下载".into());
    });
    loop {
        thread::sleep(Duration::from_millis(500));
        if cancel_requested(&store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            mark_stopped(&store, &writer, &task.id);
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
                unregister_process(&store, &task.id, &child);
                if cancel_requested(&store, &task.id) {
                    mark_stopped(&store, &writer, &task.id);
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
                        t.active_connections = 0;
                        t.eta_seconds = Some(0);
                        t.message = Some("下载完成".into());
                    });
                } else {
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.active_connections = 0;
                        t.error = Some("curl_download_failed".into());
                        t.message = Some("下载失败，请检查网络或资源地址".into());
                    });
                }
                break;
            }
            Err(error) => {
                unregister_process(&store, &task.id, &child);
                update(&store, &writer, &task.id, |t| {
                    t.state = "failed".into();
                    t.phase = "failed".into();
                    t.active_connections = 0;
                    t.error = Some(error.to_string());
                });
                break;
            }
            Ok(None) => {}
        }
    }
}

fn start_parallel_http_download(
    store: Store,
    writer: Writer,
    task: Task,
    output: String,
    total: u64,
) -> bool {
    let count = usize::from(task.download_threads.clamp(2, MAX_DOWNLOAD_THREADS));
    let part_dir = PathBuf::from(format!("{output}.streamfirefly-parts-{}", task.id));
    if fs::create_dir_all(&part_dir).is_err() {
        return false;
    }
    let ranges: Vec<(u64, u64)> = (0..count)
        .map(|index| {
            let start = total * index as u64 / count as u64;
            let end = total * (index as u64 + 1) / count as u64 - 1;
            (start, end)
        })
        .collect();
    let mut children = Vec::new();
    for (index, (start, end)) in ranges.iter().enumerate() {
        let part = part_dir.join(format!("{index:04}.part"));
        let mut args = vec![
            "--silent".into(),
            "--show-error".into(),
            "--fail".into(),
            "--location".into(),
            "--retry".into(),
            "3".into(),
            "--retry-all-errors".into(),
            "--range".into(),
            format!("{start}-{end}"),
            "--output".into(),
            part.to_string_lossy().into(),
        ];
        add_header_args(&mut args, &task);
        args.push(task.url.clone());
        match Command::new("curl")
            .args(args)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => children.push((part, register_process(&store, &task.id, child))),
            Err(_) => {
                stop_process(&store, &task.id);
                let _ = fs::remove_dir_all(&part_dir);
                return false;
            }
        }
    }
    update(&store, &writer, &task.id, |t| {
        t.state = "running".into();
        t.phase = "downloading".into();
        t.total_bytes = Some(total);
        t.active_connections = count as u8;
        t.segments_total = count as u32;
        t.segments_completed = 0;
        t.message = Some(format!("正在并发下载（{count} 路）"));
    });
    let mut sampled_at = Instant::now();
    let mut last_bytes = 0u64;
    let mut smoothed_speed = 0u64;
    loop {
        thread::sleep(Duration::from_millis(500));
        if cancel_requested(&store, &task.id) {
            stop_process(&store, &task.id);
            if let Some((first_part, _)) = children.first() {
                if fs::metadata(first_part)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0)
                    > 0
                {
                    let _ = fs::copy(first_part, &output);
                }
            }
            let _ = fs::remove_dir_all(&part_dir);
            mark_stopped(&store, &writer, &task.id);
            return true;
        }
        let bytes: u64 = children
            .iter()
            .map(|(path, _)| fs::metadata(path).map(|m| m.len()).unwrap_or(0))
            .sum();
        let sample_seconds = sampled_at.elapsed().as_secs_f64().max(0.001);
        let sampled_speed = bytes.saturating_sub(last_bytes) as f64 / sample_seconds;
        if sampled_speed > 0.0 {
            smoothed_speed = if smoothed_speed == 0 {
                sampled_speed as u64
            } else {
                (smoothed_speed as f64 * 0.6 + sampled_speed * 0.4) as u64
            };
        }
        sampled_at = Instant::now();
        last_bytes = bytes;
        let completed = children
            .iter()
            .filter(|(path, child)| {
                child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok().flatten())
                    .map(|status| status.success())
                    .unwrap_or(false)
                    && path.exists()
            })
            .count() as u32;
        update(&store, &writer, &task.id, |t| {
            t.progress = ((bytes.saturating_mul(100) / total).min(99)) as u8;
            t.downloaded_bytes = bytes;
            t.speed_bytes_per_second = smoothed_speed;
            t.eta_seconds =
                (smoothed_speed > 0).then(|| total.saturating_sub(bytes) / smoothed_speed);
            t.segments_completed = completed;
        });
        let statuses: Vec<Option<bool>> = children
            .iter()
            .map(|(_, child)| {
                child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok().flatten())
                    .map(|status| status.success())
            })
            .collect();
        if statuses.iter().all(Option::is_some) {
            for (_, child) in &children {
                unregister_process(&store, &task.id, child);
            }
            let valid = statuses.iter().all(|status| *status == Some(true))
                && children.iter().enumerate().all(|(index, (path, _))| {
                    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
                        == ranges[index].1 - ranges[index].0 + 1
                });
            if !valid {
                let _ = fs::remove_dir_all(&part_dir);
                return false;
            }
            let mut destination = match OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&output)
            {
                Ok(file) => file,
                Err(_) => {
                    let _ = fs::remove_dir_all(&part_dir);
                    return false;
                }
            };
            for (path, _) in &children {
                let mut part = match fs::File::open(path) {
                    Ok(file) => file,
                    Err(_) => {
                        let _ = fs::remove_dir_all(&part_dir);
                        return false;
                    }
                };
                if io::copy(&mut part, &mut destination).is_err() {
                    let _ = fs::remove_dir_all(&part_dir);
                    return false;
                }
            }
            let _ = fs::remove_dir_all(&part_dir);
            update(&store, &writer, &task.id, |t| {
                t.state = "succeeded".into();
                t.phase = "completed".into();
                t.progress = 100;
                t.downloaded_bytes = total;
                t.total_bytes = Some(total);
                t.active_connections = 0;
                t.segments_completed = count as u32;
                t.speed_bytes_per_second = smoothed_speed;
                t.eta_seconds = Some(0);
                t.message = Some("下载完成".into());
            });
            return true;
        }
    }
}

fn start_http_download(store: Store, writer: Writer, task: Task, output: String) {
    let probe = probe_size(&store, &task);
    if probe.cancelled || cancel_requested(&store, &task.id) {
        mark_stopped(&store, &writer, &task.id);
        return;
    }
    if probe.accept_ranges && task.download_threads > 1 {
        if let Some(total) = probe.total {
            if total >= 1024 * 1024
                && start_parallel_http_download(
                    store.clone(),
                    writer.clone(),
                    task.clone(),
                    output.clone(),
                    total,
                )
            {
                return;
            }
        }
    }
    start_single_http_download(store, writer, task, output, probe.total);
}

fn bundled_tool(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

fn start_download(store: Store, writer: Writer, task: Task) {
    thread::spawn(move || {
        if cancel_requested(&store, &task.id) {
            mark_stopped(&store, &writer, &task.id);
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
        let is_stream = task.inline_manifest.is_some()
            || task.url.to_ascii_lowercase().contains(".m3u8")
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
        let manifest_file = match task.inline_manifest.as_ref() {
            Some(manifest) => match write_inline_manifest(&task.id, manifest) {
                Ok(file) => Some(file),
                Err(error) => {
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some(error.to_string());
                        t.message = Some("无法创建临时流媒体清单".into());
                    });
                    return;
                }
            },
            None => None,
        };
        let input = manifest_file
            .as_ref()
            .map(|file| file.path().to_string_lossy().into_owned())
            .unwrap_or_else(|| task.url.clone());
        let mut ffmpeg_args: Vec<String> = [
            "-nostdin",
            "-y",
            "-loglevel",
            "error",
            "-http_multiple",
            "1",
            "-http_persistent",
            "1",
            "-http_seekable",
            "1",
            "-seg_max_retry",
            "3",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        if manifest_file.is_some() {
            ffmpeg_args.extend([
                "-protocol_whitelist".into(),
                "file,http,https,tcp,tls,crypto".into(),
            ]);
        }
        if !task.request_headers.is_empty() {
            let headers = task
                .request_headers
                .iter()
                .map(|(name, value)| format!("{name}: {value}\r\n"))
                .collect::<String>();
            ffmpeg_args.extend(["-headers".into(), headers]);
        }
        ffmpeg_args.extend([
            "-i".into(),
            input,
            "-map".into(),
            "0:v?".into(),
            "-map".into(),
            "0:a?".into(),
            "-c".into(),
            "copy".into(),
            output.clone(),
        ]);
        let child = match Command::new(bundled_tool("ffmpeg.exe"))
            .args(ffmpeg_args)
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
        update(&store, &writer, &task.id, |t| {
            t.active_connections = 1;
            t.message = Some("FFmpeg 正在使用持久连接下载并合并流媒体".into());
        });
        let mut last_bytes = 0u64;
        let mut sampled_at = Instant::now();
        loop {
            thread::sleep(Duration::from_millis(500));
            if cancel_requested(&store, &task.id) {
                if let Ok(mut child) = child.lock() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                mark_stopped(&store, &writer, &task.id);
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
                    unregister_process(&store, &task.id, &child);
                    if cancel_requested(&store, &task.id) {
                        mark_stopped(&store, &writer, &task.id);
                        return;
                    }
                    update(&store, &writer, &task.id, |t| {
                        t.state = "succeeded".into();
                        t.phase = "completed".into();
                        t.progress = 100;
                        t.downloaded_bytes =
                            fs::metadata(&output).map(|m| m.len()).unwrap_or(bytes);
                        t.total_bytes = Some(t.downloaded_bytes);
                        t.active_connections = 0;
                        t.message = Some("流媒体下载完成".into());
                    });
                    break;
                }
                Ok(Some(_)) => {
                    unregister_process(&store, &task.id, &child);
                    if cancel_requested(&store, &task.id) {
                        mark_stopped(&store, &writer, &task.id);
                        return;
                    }
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some("ffmpeg_unavailable_or_failed".into());
                        t.active_connections = 0;
                        t.message = Some("FFmpeg 无法处理此资源".into());
                    });
                    break;
                }
                Err(error) => {
                    unregister_process(&store, &task.id, &child);
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.error = Some(error.to_string());
                        t.active_connections = 0;
                    });
                    break;
                }
                Ok(None) => {}
            }
        }
    });
}

fn main() -> io::Result<()> {
    cleanup_stale_inline_manifests();
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
            "host.info" => {
                json!({"version":1,"id":id,"ok":true,"protocolVersion":3,"supportedProtocolVersions":[2,3],"capabilities":["inline-hls-v1","task-control-v1","task-pause-resume-v1"]})
            }
            "task.create" => match create_task(&store, &message["payload"]) {
                Ok(task) => {
                    start_download(store.clone(), writer.clone(), task.clone());
                    json!({"version":1,"id":id,"ok":true,"task":sanitized_task(&task)})
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
            "task.control" => match task_control(&store, &writer, &message["payload"]) {
                Ok(task) => json!({"version":1,"id":id,"ok":true,"task":task}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.list" => {
                let tasks = store.tasks.lock().unwrap();
                json!({"version":1,"id":id,"ok":true,"tasks":sanitized_tasks(&tasks)})
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
    fn persisted_tasks_strip_credentials_but_keep_download_headers_in_memory() {
        let task: Task = serde_json::from_value(json!({
            "id":"credential-test","url":"https://example.test/a.mp4","title":"test",
            "state":"running","progress":10,"output":null,"error":null,"mime":"video/mp4",
            "request_headers":{
                "cookie":"session=secret-cookie",
                "authorization":"Bearer secret-token",
                "referer":"https://example.test/page",
                "origin":"https://example.test"
            }
        }))
        .unwrap();
        assert_eq!(task.request_headers["cookie"], "session=secret-cookie");
        let public_task = sanitized_task(&task);
        assert!(!public_task.request_headers.contains_key("cookie"));
        assert!(!public_task.request_headers.contains_key("authorization"));
        assert_eq!(
            public_task.request_headers["referer"],
            "https://example.test/page"
        );
        let serialized = serde_json::to_string(&public_task).unwrap();
        assert!(!serialized.contains("secret-cookie"));
        assert!(!serialized.contains("secret-token"));
    }
    #[test]
    fn loading_old_store_scrubs_credentials_from_memory_and_disk() {
        let dir = std::env::temp_dir().join(format!("streamfirefly-store-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tasks.json");
        fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "version":STORE_VERSION,
                "tasks":[{
                    "id":"old-secret","url":"https://example.test/a.mp4","title":"old",
                    "state":"running","progress":10,"output":null,"error":null,"mime":"video/mp4",
                    "request_headers":{"cookie":"session=legacy-cookie-secret","referer":"https://example.test/page"}
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let store = load_store(&path);
        let tasks = store.tasks.lock().unwrap();
        assert_eq!(tasks[0].state, "interrupted");
        assert!(!tasks[0].request_headers.contains_key("cookie"));
        assert_eq!(
            tasks[0].request_headers["referer"],
            "https://example.test/page"
        );
        assert_eq!(
            tasks[0].message.as_deref(),
            Some("登录凭据未持久化，请从页面重新发起下载")
        );
        drop(tasks);
        let persisted = fs::read_to_string(&path).unwrap();
        assert!(!persisted.contains("legacy-cookie-secret"));
        fs::remove_dir_all(dir).unwrap();
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
            download_threads: DEFAULT_DOWNLOAD_THREADS,
            request_headers: HashMap::new(),
            active_connections: 0,
            segments_completed: 0,
            segments_total: 0,
            inline_manifest: Some(InlineManifest {
                text: "#EXTM3U\n".into(),
                base_url: "https://example.test/".into(),
            }),
        }];
        assert!(serde_json::to_value(&tasks[0])
            .unwrap()
            .get("inline_manifest")
            .is_none());
        assert_eq!(
            unique_output_path(&dir, "视频", "mp4", &tasks),
            dir.join("视频 (2).mp4")
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn inline_hls_prepare_validates_and_uses_mp4() {
        let prepared = prepare_task(&json!({
            "url":"blob:https://example.test/generated",
            "title":"内存视频",
            "inlineManifest": {
                "format":"hls",
                "text":"#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.test/one.ts\n",
                "baseUrl":"https://example.test/player"
            }
        }))
        .unwrap();
        assert_eq!(prepared["fileName"], "内存视频");
        assert_eq!(prepared["extension"], "mp4");
    }
    #[test]
    fn inline_hls_rejects_local_file_uris() {
        let result = inline_manifest(&json!({
            "inlineManifest": {
                "format":"hls",
                "text":"#EXTM3U\n#EXTINF:2,\nfile:///C:/secret.txt\n",
                "baseUrl":"https://example.test/player"
            }
        }));
        assert_eq!(result.unwrap_err(), "inline_manifest_unsafe_uri");
    }
    #[test]
    fn inline_hls_temp_file_is_removed_on_drop() {
        let manifest = InlineManifest {
            text: "#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.test/one.ts\n".into(),
            base_url: "https://example.test/player".into(),
        };
        let id = Uuid::new_v4().to_string();
        let file = write_inline_manifest(&id, &manifest).unwrap();
        let path = file.path().to_path_buf();
        assert_eq!(fs::read_to_string(&path).unwrap(), manifest.text);
        drop(file);
        assert!(!path.exists());
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
