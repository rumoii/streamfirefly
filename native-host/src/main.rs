mod hls;

use hls::{
    decrypt_aes128, load_checkpoint, local_playlist, media_header_valid, override_key_bytes,
    parse_key_override, parse_manifest_iv, parse_media_playlist, save_checkpoint, ByteRange,
    HlsCheckpoint, KeyOverride, KeyOverrideKind, KeySpec, PersistedManifest, PersistedPlan,
    PersistedSubtitlePlan, CHECKPOINT_VERSION,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs::{self, OpenOptions},
    io::{self, BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
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

#[derive(Debug, Clone)]
struct HlsSubtitlePlan {
    language: Option<String>,
    label: Option<String>,
    extension: String,
    manifest: InlineManifest,
}

#[derive(Debug, Clone)]
struct HlsPlan {
    version: u8,
    duration: f64,
    container: String,
    video_manifest: InlineManifest,
    audio_manifest: Option<InlineManifest>,
    subtitles: Vec<HlsSubtitlePlan>,
    key_override: Option<KeyOverride>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TaskOutput {
    kind: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    path: Option<String>,
    state: String,
    #[serde(default)]
    error: Option<String>,
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
    #[serde(default)]
    source_context_id: Option<String>,
    #[serde(default)]
    outputs: Vec<TaskOutput>,
    #[serde(default)]
    hls_selection: bool,
    #[serde(default)]
    hls_plan_version: u8,
    #[serde(default)]
    failed_segments: u32,
    #[serde(default)]
    retry_count: u32,
    #[serde(default)]
    checkpoint_state: Option<String>,
    #[serde(default)]
    resume_requirement: Option<String>,
    #[serde(default)]
    requires_authorization: bool,
    #[serde(default)]
    requires_key_override: bool,
    #[serde(default)]
    source_candidate_id: Option<String>,
    #[serde(skip)]
    inline_manifest: Option<InlineManifest>,
    #[serde(skip)]
    hls_plan: Option<HlsPlan>,
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
    recovery_started: Arc<AtomicBool>,
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
fn task_work_root_for_state(path: &Path) -> PathBuf {
    path.parent().unwrap_or(Path::new(".")).join("tasks")
}
fn checkpoint_path_for_state(path: &Path, id: &str) -> PathBuf {
    task_work_root_for_state(path)
        .join(id)
        .join("checkpoint.json")
}
fn task_work_dir_for_store(store: &Store, id: &str) -> PathBuf {
    task_work_root_for_state(&store.path).join(id)
}
fn checkpoint_path_for_store(store: &Store, id: &str) -> PathBuf {
    task_work_dir_for_store(store, id).join("checkpoint.json")
}
fn checkpoint_available(path: &Path) -> bool {
    path.is_file() || path.with_extension("bak").is_file()
}

fn persisted_manifest(value: &InlineManifest) -> PersistedManifest {
    PersistedManifest {
        text: value.text.clone(),
        base_url: value.base_url.clone(),
    }
}

fn persisted_plan(value: &HlsPlan) -> PersistedPlan {
    PersistedPlan {
        version: value.version,
        duration: value.duration,
        container: value.container.clone(),
        video_manifest: persisted_manifest(&value.video_manifest),
        audio_manifest: value.audio_manifest.as_ref().map(persisted_manifest),
        subtitles: value
            .subtitles
            .iter()
            .map(|subtitle| PersistedSubtitlePlan {
                language: subtitle.language.clone(),
                label: subtitle.label.clone(),
                extension: subtitle.extension.clone(),
                manifest: persisted_manifest(&subtitle.manifest),
            })
            .collect(),
    }
}

fn runtime_plan_from_persisted(value: &PersistedPlan) -> HlsPlan {
    HlsPlan {
        version: value.version,
        duration: value.duration,
        container: value.container.clone(),
        video_manifest: InlineManifest {
            text: value.video_manifest.text.clone(),
            base_url: value.video_manifest.base_url.clone(),
        },
        audio_manifest: value
            .audio_manifest
            .as_ref()
            .map(|manifest| InlineManifest {
                text: manifest.text.clone(),
                base_url: manifest.base_url.clone(),
            }),
        subtitles: value
            .subtitles
            .iter()
            .map(|subtitle| HlsSubtitlePlan {
                language: subtitle.language.clone(),
                label: subtitle.label.clone(),
                extension: subtitle.extension.clone(),
                manifest: InlineManifest {
                    text: subtitle.manifest.text.clone(),
                    base_url: subtitle.manifest.base_url.clone(),
                },
            })
            .collect(),
        key_override: None,
    }
}

fn new_checkpoint(task_id: &str, plan: &HlsPlan) -> Result<HlsCheckpoint, String> {
    let persisted = persisted_plan(plan);
    let mut tracks = vec![parse_media_playlist(
        "video",
        "video",
        None,
        None,
        &persisted.video_manifest,
    )?];
    if let Some(audio) = &persisted.audio_manifest {
        tracks.push(parse_media_playlist(
            "audio",
            "audio",
            None,
            Some("外部音轨".into()),
            audio,
        )?);
    }
    for (index, subtitle) in persisted.subtitles.iter().enumerate() {
        tracks.push(parse_media_playlist(
            &format!("subtitle-{index}"),
            "subtitle",
            subtitle.language.clone(),
            subtitle.label.clone(),
            &subtitle.manifest,
        )?);
    }
    Ok(HlsCheckpoint {
        version: CHECKPOINT_VERSION,
        task_id: task_id.into(),
        plan: persisted,
        tracks,
    })
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
        let had_credentials = task.requires_authorization
            || task
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
            let recoverable_hls = task.hls_plan_version >= 2
                && checkpoint_available(&checkpoint_path_for_state(path, &task.id));
            task.state = "interrupted".into();
            task.phase = "interrupted".into();
            task.error = Some("native_host_restarted".into());
            task.resume_requirement = if !recoverable_hls {
                None
            } else if had_credentials && task.requires_key_override {
                Some("authorization_and_key_required".into())
            } else if had_credentials {
                Some("authorization_required".into())
            } else if task.requires_key_override {
                Some("key_required".into())
            } else {
                None
            };
            task.checkpoint_state = task.hls_selection.then(|| {
                if recoverable_hls {
                    "recoverable"
                } else {
                    "missing"
                }
                .into()
            });
            task.message = Some(if !recoverable_hls {
                if had_credentials {
                    "登录凭据未持久化，请从页面重新发起下载"
                } else {
                    "本地助手重新启动，请重新发起下载"
                }
                .into()
            } else if had_credentials {
                "登录凭据未持久化，请回到来源页面重新授权后继续".into()
            } else if task.requires_key_override {
                "自定义密钥未持久化，请重新输入后继续".into()
            } else {
                "本地助手重新启动，正在恢复已完成切片".into()
            });
            for output in &mut task.outputs {
                if matches!(output.state.as_str(), "queued" | "starting" | "running") {
                    output.state = "interrupted".into();
                    output.error = Some("native_host_restarted".into());
                }
            }
        }
    }
    let store = Store {
        path: path.to_path_buf(),
        tasks: Arc::new(Mutex::new(tasks)),
        processes: Arc::new(Mutex::new(HashMap::new())),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
        pauses: Arc::new(Mutex::new(HashSet::new())),
        recovery_started: Arc::new(AtomicBool::new(false)),
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
    copy.hls_plan = None;
    if copy.outputs.len() <= 1 {
        if let Some(primary) = copy
            .outputs
            .iter_mut()
            .find(|output| output.kind == "media")
        {
            primary.state = copy.state.clone();
            primary.error = copy.error.clone();
        }
    }
    if copy.outputs.is_empty() && copy.output.is_some() {
        copy.outputs.push(TaskOutput {
            kind: "media".into(),
            language: None,
            label: None,
            path: copy.output.clone(),
            state: copy.state.clone(),
            error: copy.error.clone(),
        });
    }
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

fn parse_inline_manifest_value(value: &Value) -> Result<InlineManifest, &'static str> {
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
    Ok(InlineManifest {
        text: text.into(),
        base_url: base_url.into(),
    })
}

fn inline_manifest(payload: &Value) -> Result<Option<InlineManifest>, &'static str> {
    let Some(value) = payload
        .get("inlineManifest")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    parse_inline_manifest_value(value).map(Some)
}

fn hls_plan(payload: &Value) -> Result<Option<HlsPlan>, &'static str> {
    let Some(value) = payload.get("hlsPlan").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let version = value["version"]
        .as_u64()
        .filter(|version| matches!(*version, 1 | 2))
        .ok_or("hls_plan_version_unsupported")? as u8;
    if version == 1 && value.get("keyOverride").is_some_and(|item| !item.is_null()) {
        return Err("hls_plan_version_unsupported");
    }
    let duration = value["duration"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("hls_plan_invalid")?;
    let container = value["container"]
        .as_str()
        .filter(|value| matches!(*value, "mp4" | "mkv"))
        .ok_or("hls_plan_invalid")?
        .to_string();
    let video_manifest = parse_inline_manifest_value(&value["videoManifest"])?;
    let audio_manifest = value
        .get("audioManifest")
        .filter(|item| !item.is_null())
        .map(parse_inline_manifest_value)
        .transpose()?;
    let subtitles = value["subtitles"]
        .as_array()
        .ok_or("hls_plan_invalid")?
        .iter()
        .map(|item| {
            let extension = item["extension"]
                .as_str()
                .filter(|value| matches!(*value, "vtt" | "srt" | "ass"))
                .ok_or("hls_plan_invalid")?
                .to_string();
            Ok(HlsSubtitlePlan {
                language: item["language"].as_str().and_then(safe_file_stem),
                label: item["label"]
                    .as_str()
                    .map(|value| value.chars().take(80).collect()),
                extension,
                manifest: parse_inline_manifest_value(&item["manifest"])?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    if subtitles.len() > 16 {
        return Err("hls_plan_too_many_subtitles");
    }
    let key_override = value
        .get("keyOverride")
        .filter(|item| !item.is_null())
        .map(|item| {
            parse_key_override(
                item["kind"].as_str().unwrap_or(""),
                item["value"].as_str().unwrap_or(""),
                item["iv"].as_str(),
            )
            .map_err(|_| "hls_key_override_invalid")
        })
        .transpose()?;
    Ok(Some(HlsPlan {
        version,
        duration,
        container,
        video_manifest,
        audio_manifest,
        subtitles,
        key_override,
    }))
}

fn write_inline_manifest(task_id: &str, manifest: &InlineManifest) -> io::Result<TempManifestFile> {
    write_named_manifest(task_id, "input", manifest)
}

fn write_named_manifest(
    task_id: &str,
    name: &str,
    manifest: &InlineManifest,
) -> io::Result<TempManifestFile> {
    let dir = inline_manifest_dir();
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{task_id}-{name}.m3u8"));
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
    let plan = hls_plan(payload)?;
    if manifest.is_none() && plan.is_none() {
        payload["url"]
            .as_str()
            .filter(|url| is_network_url(url))
            .ok_or("invalid_url")?;
    }
    let extension = plan
        .as_ref()
        .map(|value| value.container.clone())
        .unwrap_or_else(|| extension_for(payload));
    Ok(json!({"fileName": recommended_file_stem(payload), "extension": extension}))
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
    let hls_plan = hls_plan(payload)?;
    let hls_selection = hls_plan.is_some();
    let url = payload["url"]
        .as_str()
        .filter(|url| is_network_url(url))
        .or_else(|| {
            inline_manifest
                .as_ref()
                .map(|manifest| manifest.base_url.as_str())
        })
        .or_else(|| {
            hls_plan
                .as_ref()
                .map(|plan| plan.video_manifest.base_url.as_str())
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
    let ext = hls_plan
        .as_ref()
        .map(|value| value.container.clone())
        .unwrap_or_else(|| extension_for(payload));
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
    let request_headers = allowed_request_headers(payload);
    let requires_authorization = request_headers
        .keys()
        .any(|name| is_sensitive_request_header(name));
    let hls_plan_version = hls_plan.as_ref().map(|plan| plan.version).unwrap_or(0);
    let requires_key_override = hls_plan
        .as_ref()
        .is_some_and(|plan| plan.key_override.is_some());
    let mut reserved_sidecars = HashSet::new();
    let outputs = std::iter::once(TaskOutput {
        kind: "media".into(),
        language: None,
        label: None,
        path: Some(output.to_string_lossy().into()),
        state: "queued".into(),
        error: None,
    })
    .chain(
        hls_plan
            .as_ref()
            .into_iter()
            .flat_map(|plan| plan.subtitles.iter())
            .enumerate()
            .map(|(index, subtitle)| {
                let base_language = subtitle
                    .language
                    .clone()
                    .unwrap_or_else(|| format!("subtitle-{}", index + 1));
                let mut language = base_language.clone();
                let mut suffix = 2;
                while !reserved_sidecars.insert(format!(
                    "{}.{}",
                    language.to_ascii_lowercase(),
                    subtitle.extension
                )) {
                    language = format!("{base_language}-{suffix}");
                    suffix += 1;
                }
                let subtitle_path = output.with_file_name(format!(
                    "{}.{}.{}",
                    output.file_stem().unwrap_or_default().to_string_lossy(),
                    language,
                    subtitle.extension
                ));
                TaskOutput {
                    kind: "subtitle".into(),
                    language: subtitle.language.clone(),
                    label: subtitle.label.clone(),
                    path: Some(subtitle_path.to_string_lossy().into()),
                    state: "queued".into(),
                    error: None,
                }
            }),
    )
    .collect();
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
        source_context_id: payload["sourceContextId"].as_str().map(str::to_string),
        outputs,
        hls_selection,
        hls_plan_version,
        failed_segments: 0,
        retry_count: 0,
        checkpoint_state: (hls_plan_version >= 2).then(|| "preparing".into()),
        resume_requirement: None,
        requires_authorization,
        requires_key_override,
        source_candidate_id: payload["candidateId"].as_str().map(str::to_string),
        inline_manifest,
        hls_plan,
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
        for output in &mut task.outputs {
            if matches!(output.state.as_str(), "queued" | "starting" | "running") {
                output.state = if paused { "paused" } else { "cancelled" }.into();
            }
        }
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

fn ensure_restart_context(store: &Store, task: &Task) -> Result<(), &'static str> {
    if task.hls_selection
        && task.hls_plan.is_none()
        && !(task.hls_plan_version >= 2
            && checkpoint_available(&checkpoint_path_for_store(store, &task.id)))
    {
        Err("hls_plan_expired")
    } else {
        Ok(())
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
        "resume" | "retry" | "reauthorize" => {
            let allowed = if action == "resume" {
                matches!(task.state.as_str(), "paused" | "interrupted")
            } else if action == "reauthorize" {
                task.state == "interrupted"
            } else {
                matches!(
                    task.state.as_str(),
                    "failed" | "partial" | "cancelled" | "interrupted" | "paused"
                )
            };
            if !allowed {
                return Err(if action == "resume" {
                    "task_not_resumable"
                } else if action == "reauthorize" {
                    "task_not_awaiting_authorization"
                } else {
                    "task_not_retryable"
                });
            }
            ensure_restart_context(store, &task)?;
            let resume_context = payload
                .get("resumeContext")
                .filter(|value| value.is_object());
            let resumed_headers = resume_context
                .map(allowed_request_headers)
                .unwrap_or_default();
            let resumed_key_override = resume_context
                .and_then(|value| value.get("keyOverride"))
                .filter(|value| !value.is_null())
                .map(|value| {
                    parse_key_override(
                        value["kind"].as_str().unwrap_or(""),
                        value["value"].as_str().unwrap_or(""),
                        value["iv"].as_str(),
                    )
                    .map_err(|_| "hls_key_override_invalid")
                })
                .transpose()?;
            let mut resumed_plan = task.hls_plan.clone().or_else(|| {
                (task.hls_plan_version >= 2)
                    .then(|| load_checkpoint(&checkpoint_path_for_store(store, &task.id)).ok())
                    .flatten()
                    .map(|checkpoint| runtime_plan_from_persisted(&checkpoint.plan))
            });
            if let (Some(plan), Some(key_override)) = (resumed_plan.as_mut(), resumed_key_override)
            {
                plan.key_override = Some(key_override);
            }
            if task
                .resume_requirement
                .as_deref()
                .is_some_and(|value| value.contains("authorization"))
                && !resumed_headers
                    .keys()
                    .any(|name| is_sensitive_request_header(name))
            {
                return Err("hls_authorization_required");
            }
            if task
                .resume_requirement
                .as_deref()
                .is_some_and(|value| value.contains("key"))
                && !resumed_plan
                    .as_ref()
                    .is_some_and(|plan| plan.key_override.is_some())
            {
                return Err("hls_key_required");
            }
            clear_pause(store, id);
            clear_cancellation(store, id);
            update(store, writer, id, move |task| {
                if !resumed_headers.is_empty() {
                    if resumed_headers
                        .keys()
                        .any(|name| is_sensitive_request_header(name))
                    {
                        task.requires_authorization = true;
                    }
                    task.request_headers = resumed_headers;
                }
                if let Some(plan) = resumed_plan {
                    task.hls_plan = Some(plan);
                }
                task.state = "retrying".into();
                task.phase = "retrying".into();
                task.attempt = task.attempt.saturating_add(1);
                task.error = None;
                task.speed_bytes_per_second = 0;
                task.eta_seconds = None;
                task.resume_requirement = None;
                task.message = Some(
                    if action == "resume" {
                        "正在恢复下载"
                    } else if action == "reauthorize" {
                        "授权已更新，正在继续下载"
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

fn task_output_paths(task: &Task) -> HashSet<String> {
    let mut paths = HashSet::new();
    if let Some(path) = &task.output {
        paths.insert(path.clone());
    }
    for output in &task.outputs {
        if let Some(path) = &output.path {
            paths.insert(path.clone());
        }
    }
    paths
}

fn delete_task_outputs(task: &Task) -> Result<bool, &'static str> {
    let mut deleted = false;
    for path in task_output_paths(task) {
        deleted |= delete_output(&path)?;
    }
    Ok(deleted)
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
        delete_task_outputs(&task)?
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
    let _ = fs::remove_dir_all(task_work_dir_for_store(store, id));
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

#[derive(Clone)]
struct HlsDownloadJob {
    track_index: usize,
    item_index: usize,
    is_map: bool,
    uri: String,
    byte_range: Option<ByteRange>,
    key: Option<KeySpec>,
    sequence: u64,
    destination: PathBuf,
    validate_decryption: bool,
}

struct HlsDownloadResult {
    job: HlsDownloadJob,
    bytes: u64,
    retries: u32,
    error: Option<String>,
}

fn hls_curl_once(
    store: &Store,
    task: &Task,
    url: &str,
    range: Option<&ByteRange>,
    destination: &Path,
    abort: &AtomicBool,
) -> Result<(u64, u16), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension(format!(
        "{}.download",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("part")
    ));
    let response_headers = destination.with_extension(format!(
        "{}.headers",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("part")
    ));
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&response_headers);
    let mut args: Vec<String> = [
        "--silent",
        "--show-error",
        "--location",
        "--connect-timeout",
        "10",
        "--max-time",
        "120",
        "--output",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    args.push(temporary.to_string_lossy().into_owned());
    args.extend([
        "--dump-header".into(),
        response_headers.to_string_lossy().into_owned(),
    ]);
    args.extend(["--write-out".into(), "%{http_code}".into()]);
    if let Some(range) = range {
        args.extend([
            "--range".into(),
            format!("{}-{}", range.start, range.start + range.length - 1),
        ]);
    }
    add_header_args(&mut args, task);
    args.push(url.into());
    let mut child = Command::new("curl")
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let mut stdout = child.stdout.take();
    let child = register_process(store, &task.id, child);
    loop {
        if abort.load(Ordering::Relaxed) || cancel_requested(store, &task.id) {
            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
                let _ = process.wait();
            }
            unregister_process(store, &task.id, &child);
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(&response_headers);
            return Err("cancelled".into());
        }
        let status = child
            .lock()
            .map_err(|_| "process_lock_poisoned".to_string())?
            .try_wait()
            .map_err(|error| error.to_string())?;
        if let Some(status) = status {
            let mut response = String::new();
            if let Some(mut stdout) = stdout.take() {
                let _ = stdout.read_to_string(&mut response);
            }
            unregister_process(store, &task.id, &child);
            let http_status = response.trim().parse::<u16>().unwrap_or(0);
            if !status.success() || !(200..300).contains(&http_status) {
                let retry_after = fs::read_to_string(&response_headers)
                    .ok()
                    .and_then(|headers| {
                        headers.lines().rev().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.trim()
                                .eq_ignore_ascii_case("retry-after")
                                .then(|| value.trim().parse::<u64>().ok())
                                .flatten()
                        })
                    })
                    .map(|seconds| seconds.min(30));
                let _ = fs::remove_file(&temporary);
                let _ = fs::remove_file(&response_headers);
                return Err(match retry_after {
                    Some(seconds) => {
                        format!("http_status_{http_status}:retry_after={seconds}")
                    }
                    None => format!("http_status_{http_status}"),
                });
            }
            let bytes = fs::metadata(&temporary)
                .map_err(|error| error.to_string())?
                .len();
            if let Some(range) = range {
                if bytes != range.length {
                    let _ = fs::remove_file(&temporary);
                    return Err("hls_byte_range_length_mismatch".into());
                }
            }
            if destination.exists() {
                fs::remove_file(destination).map_err(|error| error.to_string())?;
            }
            fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
            let _ = fs::remove_file(&response_headers);
            return Ok((bytes, http_status));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn retryable_hls_error(error: &str) -> bool {
    let status = error
        .strip_prefix("http_status_")
        .and_then(|value| value.split(':').next())
        .and_then(|value| value.parse::<u16>().ok());
    match status {
        Some(0 | 408 | 429) => true,
        Some(value) if value >= 500 => true,
        Some(_) => false,
        None => matches!(
            error,
            "hls_byte_range_length_mismatch"
                | "connection_reset"
                | "operation_timed_out"
                | "curl_failed"
        ),
    }
}

fn authorization_hls_error(error: &str) -> bool {
    error.starts_with("http_status_401") || error.starts_with("http_status_403")
}

fn retry_after_seconds(error: &str) -> Option<u64> {
    error
        .split(":retry_after=")
        .nth(1)
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.min(30))
}

fn wait_retry(store: &Store, task_id: &str, abort: &AtomicBool, seconds: u64) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if abort.load(Ordering::Relaxed) || cancel_requested(store, task_id) {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}

fn load_hls_key(
    store: &Store,
    task: &Task,
    specification: &KeySpec,
    key_override: Option<&KeyOverride>,
    work_dir: &Path,
    abort: &AtomicBool,
    cache: &Mutex<HashMap<String, [u8; 16]>>,
) -> Result<[u8; 16], String> {
    if specification.method != "AES-128" {
        return Err("hls_encryption_unsupported".into());
    }
    if let Some(value) = key_override {
        if let Some(bytes) = override_key_bytes(value)? {
            return Ok(bytes);
        }
    }
    let url = key_override
        .filter(|value| value.kind == KeyOverrideKind::Url)
        .map(|value| value.value.as_str())
        .or(specification.uri.as_deref())
        .ok_or_else(|| "hls_key_uri_missing".to_string())?;
    if let Some(value) = cache.lock().unwrap().get(url).copied() {
        return Ok(value);
    }
    let key_file = work_dir.join(format!("key-{}.download", Uuid::new_v4()));
    let result = hls_curl_once(store, task, url, None, &key_file, abort);
    let bytes = match result {
        Ok(_) => fs::read(&key_file).map_err(|error| error.to_string())?,
        Err(error) => return Err(error),
    };
    let _ = fs::remove_file(&key_file);
    let key: [u8; 16] = bytes
        .try_into()
        .map_err(|_| "hls_key_length_invalid".to_string())?;
    cache.lock().unwrap().insert(url.into(), key);
    Ok(key)
}

fn execute_hls_job(
    store: &Store,
    task: &Task,
    job: &HlsDownloadJob,
    key_override: Option<&KeyOverride>,
    work_dir: &Path,
    abort: &AtomicBool,
    key_cache: &Mutex<HashMap<String, [u8; 16]>>,
) -> HlsDownloadResult {
    let mut retries = 0;
    loop {
        if abort.load(Ordering::Relaxed) || cancel_requested(store, &task.id) {
            return HlsDownloadResult {
                job: job.clone(),
                bytes: 0,
                retries,
                error: Some("cancelled".into()),
            };
        }
        let encrypted = job.key.is_some();
        let download_path = if encrypted {
            job.destination.with_extension("encrypted")
        } else {
            job.destination.clone()
        };
        let attempt = hls_curl_once(
            store,
            task,
            &job.uri,
            job.byte_range.as_ref(),
            &download_path,
            abort,
        )
        .and_then(|(bytes, _)| {
            if let Some(specification) = &job.key {
                let key = load_hls_key(
                    store,
                    task,
                    specification,
                    key_override,
                    work_dir,
                    abort,
                    key_cache,
                )?;
                let iv = key_override
                    .and_then(|value| value.iv)
                    .map(Ok)
                    .unwrap_or_else(|| {
                        parse_manifest_iv(specification.iv.as_deref(), job.sequence)
                    })?;
                let encrypted_bytes =
                    fs::read(&download_path).map_err(|error| error.to_string())?;
                let decrypted = decrypt_aes128(&encrypted_bytes, &key, &iv).map_err(|error| {
                    if job.validate_decryption {
                        "hls_key_validation_failed".to_string()
                    } else {
                        error
                    }
                })?;
                if job.validate_decryption && !media_header_valid(&decrypted) {
                    return Err("hls_key_validation_failed".into());
                }
                if let Some(parent) = job.destination.parent() {
                    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
                }
                fs::write(&job.destination, &decrypted).map_err(|error| error.to_string())?;
                let _ = fs::remove_file(&download_path);
                Ok(decrypted.len() as u64)
            } else {
                Ok(bytes)
            }
        });
        match attempt {
            Ok(bytes) => {
                return HlsDownloadResult {
                    job: job.clone(),
                    bytes,
                    retries,
                    error: None,
                }
            }
            Err(error) if error == "cancelled" => {
                return HlsDownloadResult {
                    job: job.clone(),
                    bytes: 0,
                    retries,
                    error: Some(error),
                }
            }
            Err(error) if retryable_hls_error(&error) && retries < 3 => {
                retries += 1;
                let delay = retry_after_seconds(&error).unwrap_or(1 << (retries - 1));
                if !wait_retry(store, &task.id, abort, delay) {
                    return HlsDownloadResult {
                        job: job.clone(),
                        bytes: 0,
                        retries,
                        error: Some("cancelled".into()),
                    };
                }
            }
            Err(error) => {
                return HlsDownloadResult {
                    job: job.clone(),
                    bytes: 0,
                    retries,
                    error: Some(error),
                }
            }
        }
    }
}

fn checkpoint_counts(checkpoint: &HlsCheckpoint) -> (u32, u32, u32, u32, u64) {
    let segments = checkpoint.tracks.iter().flat_map(|track| &track.segments);
    let total = segments.clone().count() as u32;
    let completed = segments
        .clone()
        .filter(|segment| segment.state == "succeeded")
        .count() as u32;
    let failed = segments
        .clone()
        .filter(|segment| segment.state == "failed")
        .count() as u32;
    let retries = segments.clone().map(|segment| segment.retries).sum();
    let bytes = segments.map(|segment| segment.bytes).sum();
    (completed, total, failed, retries, bytes)
}

fn checkpoint_jobs(checkpoint: &mut HlsCheckpoint, work_dir: &Path) -> Vec<HlsDownloadJob> {
    let mut jobs = Vec::new();
    for (track_index, track) in checkpoint.tracks.iter_mut().enumerate() {
        let track_dir = work_dir.join(&track.id);
        for (item_index, map) in track.maps.iter_mut().enumerate() {
            let destination = track_dir.join(&map.local_name);
            if map.state == "succeeded" && destination.is_file() {
                continue;
            }
            map.state = "pending".into();
            map.error = None;
            jobs.push(HlsDownloadJob {
                track_index,
                item_index,
                is_map: true,
                uri: map.uri.clone(),
                byte_range: map.byte_range.clone(),
                key: map.key.clone(),
                sequence: 0,
                destination,
                validate_decryption: false,
            });
        }
        for (item_index, segment) in track.segments.iter_mut().enumerate() {
            let destination = track_dir.join(&segment.local_name);
            if segment.state == "succeeded" && destination.is_file() {
                continue;
            }
            segment.state = "pending".into();
            segment.error = None;
            jobs.push(HlsDownloadJob {
                track_index,
                item_index,
                is_map: false,
                uri: segment.uri.clone(),
                byte_range: segment.byte_range.clone(),
                key: segment.key.clone(),
                sequence: segment.sequence,
                destination,
                validate_decryption: segment.index == 0,
            });
        }
    }
    jobs
}

fn apply_hls_result(checkpoint: &mut HlsCheckpoint, result: &HlsDownloadResult) {
    let track = &mut checkpoint.tracks[result.job.track_index];
    if result.job.is_map {
        let item = &mut track.maps[result.job.item_index];
        item.retries = item.retries.saturating_add(result.retries);
        item.bytes = result.bytes;
        item.error = result
            .error
            .as_ref()
            .filter(|error| error.as_str() != "cancelled")
            .cloned();
        item.state = if result.error.as_deref() == Some("cancelled") {
            "pending"
        } else if result.error.is_none() {
            "succeeded"
        } else {
            "failed"
        }
        .into();
    } else {
        let item = &mut track.segments[result.job.item_index];
        item.retries = item.retries.saturating_add(result.retries);
        item.bytes = result.bytes;
        item.error = result
            .error
            .as_ref()
            .filter(|error| error.as_str() != "cancelled")
            .cloned();
        item.state = if result.error.as_deref() == Some("cancelled") {
            "pending"
        } else if result.error.is_none() {
            "succeeded"
        } else {
            "failed"
        }
        .into();
    }
}

fn publish_hls_progress(
    store: &Store,
    writer: &Writer,
    task_id: &str,
    checkpoint: &HlsCheckpoint,
    started: Instant,
    sampled_at: &mut Instant,
    previous_bytes: &mut u64,
) {
    let (completed, total, failed, retries, bytes) = checkpoint_counts(checkpoint);
    let elapsed = sampled_at.elapsed().as_secs_f64().max(0.001);
    let speed = ((bytes.saturating_sub(*previous_bytes)) as f64 / elapsed) as u64;
    *previous_bytes = bytes;
    *sampled_at = Instant::now();
    update(store, writer, task_id, |current| {
        current.segments_completed = completed;
        current.segments_total = total;
        current.failed_segments = failed;
        current.retry_count = retries;
        current.downloaded_bytes = bytes;
        current.speed_bytes_per_second = speed;
        current.progress = if total == 0 {
            0
        } else {
            ((completed * 90) / total).min(89) as u8
        };
        current.eta_seconds = (completed > 0 && completed < total).then(|| {
            (started.elapsed().as_secs_f64() / completed as f64 * (total - completed) as f64) as u64
        });
        current.message = Some(format!("已完成 {completed}/{total} 个切片"));
    });
}

fn merge_hls_checkpoint(
    store: &Store,
    writer: &Writer,
    task: &Task,
    output: &str,
    checkpoint: &HlsCheckpoint,
    work_dir: &Path,
) -> Result<usize, String> {
    let video = checkpoint
        .tracks
        .iter()
        .find(|track| track.kind == "video")
        .ok_or_else(|| "hls_video_track_missing".to_string())?;
    let video_playlist = local_playlist(video, &work_dir.join(&video.id))?;
    let audio = checkpoint.tracks.iter().find(|track| track.kind == "audio");
    let audio_playlist = audio
        .map(|track| local_playlist(track, &work_dir.join(&track.id)))
        .transpose()?;
    let media_already_done = task.outputs.iter().any(|item| {
        item.kind == "media"
            && item.state == "succeeded"
            && item
                .path
                .as_deref()
                .is_some_and(|path| Path::new(path).is_file())
    });
    if !media_already_done {
        let mut args = vec![
            "-nostdin".into(),
            "-y".into(),
            "-loglevel".into(),
            "error".into(),
            "-protocol_whitelist".into(),
            "file".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
        ];
        args.extend(["-i".into(), video_playlist.to_string_lossy().into_owned()]);
        if let Some(audio) = &audio_playlist {
            args.extend(["-i".into(), audio.to_string_lossy().into_owned()]);
        }
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            if audio_playlist.is_some() {
                "1:a:0"
            } else {
                "0:a?"
            }
            .into(),
            "-c".into(),
            "copy".into(),
            output.into(),
        ]);
        match run_ffmpeg_with_progress(
            store,
            writer,
            task,
            args,
            checkpoint.plan.duration,
            90,
            10,
            "切片下载完成，正在无转码合并",
        ) {
            Ok(()) => update(store, writer, &task.id, |current| {
                set_output_state(current, "media", 0, "succeeded", None)
            }),
            Err(error) => {
                if error != "cancelled" {
                    update(store, writer, &task.id, |current| {
                        set_output_state(current, "media", 0, "failed", Some(error.clone()))
                    });
                }
                return Err(error);
            }
        }
    }
    let subtitle_count = checkpoint
        .tracks
        .iter()
        .filter(|track| track.kind == "subtitle")
        .count();
    let mut subtitle_failures = 0;
    for (subtitle_index, subtitle) in checkpoint
        .tracks
        .iter()
        .filter(|track| track.kind == "subtitle")
        .enumerate()
    {
        let Some(path) = task
            .outputs
            .iter()
            .filter(|output| output.kind == "subtitle")
            .nth(subtitle_index)
            .and_then(|output| output.path.clone())
        else {
            subtitle_failures += 1;
            continue;
        };
        if task
            .outputs
            .iter()
            .filter(|output| output.kind == "subtitle")
            .nth(subtitle_index)
            .is_some_and(|output| {
                output.state == "succeeded"
                    && output
                        .path
                        .as_deref()
                        .is_some_and(|path| Path::new(path).is_file())
            })
        {
            continue;
        }
        update(store, writer, &task.id, |current| {
            set_output_state(current, "subtitle", subtitle_index, "running", None)
        });
        let playlist = local_playlist(subtitle, &work_dir.join(&subtitle.id))?;
        let args = vec![
            "-nostdin".into(),
            "-y".into(),
            "-loglevel".into(),
            "error".into(),
            "-protocol_whitelist".into(),
            "file".into(),
            "-i".into(),
            playlist.to_string_lossy().into_owned(),
            "-map".into(),
            "0:s:0".into(),
            "-c:s".into(),
            "webvtt".into(),
            path,
        ];
        let start = 90 + ((subtitle_index * 10) / subtitle_count.max(1)) as u8;
        let span = (10 / subtitle_count.max(1)).max(1) as u8;
        match run_ffmpeg_with_progress(
            store,
            writer,
            task,
            args,
            subtitle.duration,
            start,
            span,
            "正在生成字幕文件",
        ) {
            Ok(()) => update(store, writer, &task.id, |current| {
                set_output_state(current, "subtitle", subtitle_index, "succeeded", None)
            }),
            Err(error) if error == "cancelled" => return Err(error),
            Err(error) => {
                subtitle_failures += 1;
                update(store, writer, &task.id, |current| {
                    set_output_state(current, "subtitle", subtitle_index, "failed", Some(error))
                });
            }
        }
    }
    Ok(subtitle_failures)
}

fn start_hls_checkpoint_download(
    store: Store,
    writer: Writer,
    task: Task,
    output: String,
    runtime_plan: Option<HlsPlan>,
) {
    let work_dir = task_work_dir_for_store(&store, &task.id);
    let checkpoint_file = checkpoint_path_for_store(&store, &task.id);
    let checkpoint = if checkpoint_available(&checkpoint_file) {
        match load_checkpoint(&checkpoint_file) {
            Ok(value) => value,
            Err(error) => {
                update(&store, &writer, &task.id, |current| {
                    current.state = "failed".into();
                    current.phase = "failed".into();
                    current.error = Some(error.clone());
                    current.message = Some("HLS 检查点无效，未覆盖已有恢复数据".into());
                    current.checkpoint_state = Some("invalid".into());
                });
                return;
            }
        }
    } else {
        match runtime_plan.as_ref() {
            Some(plan) => match new_checkpoint(&task.id, plan) {
                Ok(value) => value,
                Err(error) => {
                    update(&store, &writer, &task.id, |current| {
                        current.state = "failed".into();
                        current.phase = "failed".into();
                        current.error = Some(error.clone());
                        current.message = Some(
                            match error.as_str() {
                                "hls_live_not_supported" => "Beta 2 暂不支持直播 HLS",
                                "hls_map_iv_required" => "加密初始化片段缺少显式 IV",
                                "hls_encryption_unsupported" => "HLS 使用了暂不支持的加密方式",
                                _ => "无法准备 HLS 切片检查点",
                            }
                            .into(),
                        );
                        current.checkpoint_state = Some("invalid".into());
                    });
                    return;
                }
            },
            None => {
                update(&store, &writer, &task.id, |current| {
                    current.state = "failed".into();
                    current.phase = "failed".into();
                    current.error = Some("hls_checkpoint_missing".into());
                    current.message = Some("HLS 检查点不存在，请重新创建任务".into());
                    current.checkpoint_state = Some("missing".into());
                });
                return;
            }
        }
    };
    let runtime_plan =
        runtime_plan.unwrap_or_else(|| runtime_plan_from_persisted(&checkpoint.plan));
    let key_override = runtime_plan.key_override.clone();
    if task.requires_authorization
        && task
            .request_headers
            .keys()
            .all(|name| !is_sensitive_request_header(name))
    {
        update(&store, &writer, &task.id, |current| {
            current.state = "interrupted".into();
            current.phase = "authorization_required".into();
            current.resume_requirement = Some("authorization_required".into());
            current.message = Some("请回到来源页面重新授权后继续下载".into());
        });
        return;
    }
    if task.requires_key_override && key_override.is_none() {
        update(&store, &writer, &task.id, |current| {
            current.state = "interrupted".into();
            current.phase = "key_required".into();
            current.resume_requirement = Some("key_required".into());
            current.message = Some("请重新输入自定义密钥后继续下载".into());
        });
        return;
    }
    let checkpoint = Arc::new(Mutex::new(checkpoint));
    let jobs = {
        let mut checkpoint = checkpoint.lock().unwrap();
        let jobs = checkpoint_jobs(&mut checkpoint, &work_dir);
        if let Err(error) = save_checkpoint(&checkpoint_file, &checkpoint) {
            update(&store, &writer, &task.id, |current| {
                current.state = "failed".into();
                current.error = Some(error.clone());
                current.message = Some("无法保存 HLS 检查点".into());
            });
            return;
        }
        jobs
    };
    let abort = Arc::new(AtomicBool::new(false));
    let key_cache = Arc::new(Mutex::new(HashMap::new()));
    let mut jobs = jobs;
    if let Some(index) = jobs
        .iter()
        .position(|job| job.validate_decryption && job.key.is_some())
    {
        let validation_job = jobs.remove(index);
        update(&store, &writer, &task.id, |current| {
            current.state = "starting".into();
            current.phase = "validating_key".into();
            current.active_connections = 1;
            current.message = Some("正在验证 AES-128 密钥和首个媒体切片".into());
        });
        let result = execute_hls_job(
            &store,
            &task,
            &validation_job,
            key_override.as_ref(),
            &work_dir,
            &abort,
            &key_cache,
        );
        {
            let mut checkpoint = checkpoint.lock().unwrap();
            apply_hls_result(&mut checkpoint, &result);
            if let Err(error) = save_checkpoint(&checkpoint_file, &checkpoint) {
                update(&store, &writer, &task.id, |current| {
                    current.state = "failed".into();
                    current.phase = "failed".into();
                    current.error = Some(format!("hls_checkpoint_save_failed:{error}"));
                    current.active_connections = 0;
                    current.checkpoint_state = Some("invalid".into());
                    current.message = Some("无法保存密钥验证检查点".into());
                });
                return;
            }
        }
        if let Some(error) = result.error {
            if error == "cancelled" {
                mark_stopped(&store, &writer, &task.id);
                return;
            }
            update(&store, &writer, &task.id, |current| {
                if authorization_hls_error(&error) {
                    current.requires_authorization = true;
                }
                current.state = if authorization_hls_error(&error) {
                    "interrupted"
                } else {
                    "failed"
                }
                .into();
                current.phase = if authorization_hls_error(&error) {
                    "authorization_required"
                } else {
                    "failed"
                }
                .into();
                current.error = Some(error.clone());
                current.active_connections = 0;
                current.checkpoint_state = Some("recoverable".into());
                current.resume_requirement =
                    authorization_hls_error(&error).then(|| "authorization_required".into());
                current.message = Some(if error == "hls_key_validation_failed" {
                    "AES-128 密钥验证失败，尚未开始批量下载".into()
                } else if authorization_hls_error(&error) {
                    "资源授权已经失效，请从来源页面重新授权".into()
                } else {
                    "无法验证首个加密切片".into()
                });
            });
            return;
        }
    }
    let expected_results = jobs.len();
    let queue = Arc::new(Mutex::new(VecDeque::from(jobs)));
    let (sender, receiver) = mpsc::channel();
    let worker_count = usize::from(task.download_threads)
        .max(1)
        .min(queue.lock().unwrap().len().max(1));
    update(&store, &writer, &task.id, |current| {
        current.state = "running".into();
        current.phase = "downloading_segments".into();
        current.active_connections = worker_count as u8;
        current.checkpoint_state = Some("active".into());
        current.resume_requirement = None;
        current.message = Some(format!("正在下载 HLS 切片（{worker_count} 路）"));
    });
    let mut workers = Vec::new();
    for _ in 0..worker_count {
        let sender = sender.clone();
        let queue = queue.clone();
        let store = store.clone();
        let task = task.clone();
        let abort = abort.clone();
        let key_cache = key_cache.clone();
        let work_dir = work_dir.clone();
        let key_override = key_override.clone();
        workers.push(thread::spawn(move || loop {
            let job = queue.lock().unwrap().pop_front();
            let Some(job) = job else { break };
            if abort.load(Ordering::Relaxed) {
                break;
            }
            let result = execute_hls_job(
                &store,
                &task,
                &job,
                key_override.as_ref(),
                &work_dir,
                &abort,
                &key_cache,
            );
            let failed = result
                .error
                .as_deref()
                .is_some_and(|error| error != "cancelled");
            if sender.send(result).is_err() {
                break;
            }
            if failed {
                abort.store(true, Ordering::Relaxed);
                break;
            }
        }));
    }
    drop(sender);
    let started = Instant::now();
    let mut previous_bytes = 0_u64;
    let mut sampled_at = Instant::now();
    let mut last_checkpoint_save = Instant::now();
    let mut last_ui_update = Instant::now();
    let mut dirty_results = 0_usize;
    let mut received_results = 0_usize;
    let mut failure = None;
    for result in receiver {
        received_results += 1;
        let terminal_result = result.error.is_some();
        let last_result = received_results == expected_results;
        {
            let mut checkpoint = checkpoint.lock().unwrap();
            apply_hls_result(&mut checkpoint, &result);
            dirty_results += 1;
            if dirty_results >= 16
                || last_checkpoint_save.elapsed() >= Duration::from_secs(1)
                || terminal_result
                || last_result
            {
                if let Err(error) = save_checkpoint(&checkpoint_file, &checkpoint) {
                    failure = Some(format!("hls_checkpoint_save_failed:{error}"));
                    abort.store(true, Ordering::Relaxed);
                }
                dirty_results = 0;
                last_checkpoint_save = Instant::now();
            }
            if last_ui_update.elapsed() >= Duration::from_millis(250)
                || terminal_result
                || last_result
            {
                publish_hls_progress(
                    &store,
                    &writer,
                    &task.id,
                    &checkpoint,
                    started,
                    &mut sampled_at,
                    &mut previous_bytes,
                );
                last_ui_update = Instant::now();
            }
        }
        if let Some(error) = &result.error {
            if error != "cancelled" {
                failure = Some(error.clone());
                abort.store(true, Ordering::Relaxed);
                stop_process(&store, &task.id);
            }
        }
    }
    for worker in workers {
        let _ = worker.join();
    }
    {
        let checkpoint = checkpoint.lock().unwrap();
        if dirty_results > 0 {
            if let Err(error) = save_checkpoint(&checkpoint_file, &checkpoint) {
                failure.get_or_insert_with(|| format!("hls_checkpoint_save_failed:{error}"));
            }
        }
        publish_hls_progress(
            &store,
            &writer,
            &task.id,
            &checkpoint,
            started,
            &mut sampled_at,
            &mut previous_bytes,
        );
    }
    unregister_all_processes(&store, &task.id);
    if cancel_requested(&store, &task.id) {
        mark_stopped(&store, &writer, &task.id);
        return;
    }
    if let Some(error) = failure {
        let authorization = authorization_hls_error(&error);
        update(&store, &writer, &task.id, |current| {
            if authorization {
                current.requires_authorization = true;
            }
            current.state = if authorization {
                "interrupted"
            } else {
                "failed"
            }
            .into();
            current.phase = if authorization {
                "authorization_required"
            } else {
                "failed"
            }
            .into();
            current.error = Some(error.clone());
            current.active_connections = 0;
            current.checkpoint_state = Some("recoverable".into());
            current.resume_requirement = authorization.then(|| "authorization_required".into());
            current.message = Some(if authorization {
                "资源授权已经失效，请从来源页面重新授权".into()
            } else if error == "hls_key_validation_failed" {
                "AES-128 密钥验证失败，未继续下载其他切片".into()
            } else {
                "部分 HLS 切片下载失败，可重试继续".into()
            });
        });
        return;
    }
    let checkpoint_value = checkpoint.lock().unwrap().clone();
    update(&store, &writer, &task.id, |current| {
        current.phase = "merging".into();
        current.active_connections = 0;
        current.progress = 90;
        current.message = Some("切片下载完成，正在合并".into());
    });
    match merge_hls_checkpoint(
        &store,
        &writer,
        &task,
        &output,
        &checkpoint_value,
        &work_dir,
    ) {
        Ok(0) => {
            let _ = fs::remove_dir_all(&work_dir);
            update(&store, &writer, &task.id, |current| {
                current.state = "succeeded".into();
                current.phase = "completed".into();
                current.progress = 100;
                current.active_connections = 0;
                current.eta_seconds = Some(0);
                current.checkpoint_state = Some("cleaned".into());
                current.resume_requirement = None;
                current.error = None;
                current.message = Some("HLS 视频和所选字幕下载完成".into());
            });
        }
        Ok(subtitle_failures) => update(&store, &writer, &task.id, |current| {
            current.state = "partial".into();
            current.phase = "partial".into();
            current.progress = 100;
            current.active_connections = 0;
            current.eta_seconds = Some(0);
            current.checkpoint_state = Some("recoverable".into());
            current.error = Some("subtitle_output_failed".into());
            current.message = Some(format!(
                "视频已完成，{subtitle_failures} 条字幕生成失败，可重试"
            ));
        }),
        Err(error) if error == "cancelled" => mark_stopped(&store, &writer, &task.id),
        Err(error) => update(&store, &writer, &task.id, |current| {
            current.state = "failed".into();
            current.phase = "failed".into();
            current.error = Some(error.clone());
            current.checkpoint_state = Some("recoverable".into());
            current.message = Some("切片已保存，但 FFmpeg 合并失败".into());
        }),
    }
}

fn bundled_tool(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
}

fn ffmpeg_base_args() -> Vec<String> {
    [
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
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn append_ffmpeg_input(args: &mut Vec<String>, task: &Task, path: &Path) {
    if !task.request_headers.is_empty() {
        let headers = task
            .request_headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect::<String>();
        args.extend(["-headers".into(), headers]);
    }
    args.extend(["-i".into(), path.to_string_lossy().into_owned()]);
}

fn set_output_state(task: &mut Task, kind: &str, index: usize, state: &str, error: Option<String>) {
    if let Some(output) = task
        .outputs
        .iter_mut()
        .filter(|output| output.kind == kind)
        .nth(index)
    {
        output.state = state.into();
        output.error = error;
    }
}

fn run_ffmpeg_with_progress(
    store: &Store,
    writer: &Writer,
    task: &Task,
    args: Vec<String>,
    duration: f64,
    progress_start: u8,
    progress_span: u8,
    message: &str,
) -> Result<(), String> {
    let mut child = Command::new(bundled_tool("ffmpeg.exe"))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg_progress_unavailable".to_string())?;
    let child = register_process(store, &task.id, child);
    let position = Arc::new(Mutex::new(0.0_f64));
    let reader_position = position.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
            {
                if let Ok(value) = value.parse::<f64>() {
                    if let Ok(mut current) = reader_position.lock() {
                        *current = value / 1_000_000.0;
                    }
                }
            }
        }
    });
    let mut last_bytes = 0;
    let mut sampled_at = Instant::now();
    let started_at = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(250));
        if cancel_requested(store, &task.id) {
            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
                let _ = process.wait();
            }
            unregister_process(store, &task.id, &child);
            return Err("cancelled".into());
        }
        let bytes = task
            .output
            .as_deref()
            .and_then(|path| fs::metadata(path).ok())
            .map(|metadata| metadata.len())
            .unwrap_or(last_bytes);
        let speed = (bytes.saturating_sub(last_bytes) as f64
            / sampled_at.elapsed().as_secs_f64().max(0.001)) as u64;
        last_bytes = bytes;
        sampled_at = Instant::now();
        let seconds = position.lock().map(|value| *value).unwrap_or(0.0);
        let stage = if duration > 0.0 {
            (seconds / duration).clamp(0.0, 0.99)
        } else {
            0.0
        };
        update(store, writer, &task.id, |current| {
            current.state = "running".into();
            current.phase = "merging".into();
            current.progress = progress_start
                .saturating_add((stage * progress_span as f64) as u8)
                .min(99);
            current.downloaded_bytes = bytes;
            current.speed_bytes_per_second = speed;
            current.eta_seconds = (seconds > 0.0 && duration > seconds).then(|| {
                ((duration - seconds) / (seconds / started_at.elapsed().as_secs_f64().max(0.25)))
                    as u64
            });
            current.message = Some(message.into());
        });
        match child
            .lock()
            .map_err(|_| "process_lock_poisoned".to_string())
            .and_then(|mut process| process.try_wait().map_err(|error| error.to_string()))?
        {
            Some(status) => {
                unregister_process(store, &task.id, &child);
                return if status.success() {
                    Ok(())
                } else {
                    Err("ffmpeg_unavailable_or_failed".into())
                };
            }
            None => {}
        }
    }
}

fn start_hls_plan_download(
    store: Store,
    writer: Writer,
    task: Task,
    output: String,
    plan: HlsPlan,
) {
    let video_already_done = task
        .outputs
        .iter()
        .find(|item| item.kind == "media")
        .is_some_and(|item| {
            item.state == "succeeded"
                && item
                    .path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).is_file())
        });
    if !video_already_done {
        update(&store, &writer, &task.id, |current| {
            current.state = "starting".into();
            current.phase = "starting".into();
            current.message = Some("正在准备选定的 HLS 轨道".into());
            set_output_state(current, "media", 0, "starting", None);
        });
        let video_file = match write_named_manifest(&task.id, "video", &plan.video_manifest) {
            Ok(file) => file,
            Err(error) => {
                update(&store, &writer, &task.id, |current| {
                    current.state = "failed".into();
                    current.error = Some(error.to_string());
                    set_output_state(current, "media", 0, "failed", Some(error.to_string()));
                });
                return;
            }
        };
        let audio_file = match plan.audio_manifest.as_ref() {
            Some(manifest) => match write_named_manifest(&task.id, "audio", manifest) {
                Ok(file) => Some(file),
                Err(error) => {
                    update(&store, &writer, &task.id, |current| {
                        current.state = "failed".into();
                        current.phase = "failed".into();
                        current.error = Some(error.to_string());
                        current.message = Some("无法准备所选音轨".into());
                        set_output_state(current, "media", 0, "failed", Some(error.to_string()));
                    });
                    return;
                }
            },
            None => None,
        };
        let mut args = ffmpeg_base_args();
        args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
        append_ffmpeg_input(&mut args, &task, video_file.path());
        if let Some(audio) = &audio_file {
            append_ffmpeg_input(&mut args, &task, audio.path());
        }
        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            if audio_file.is_some() {
                "1:a:0".into()
            } else {
                "0:a?".into()
            },
            "-c".into(),
            "copy".into(),
            output.clone(),
        ]);
        let media_span = if plan.subtitles.is_empty() { 100 } else { 90 };
        match run_ffmpeg_with_progress(
            &store,
            &writer,
            &task,
            args,
            plan.duration,
            0,
            media_span,
            "正在下载所选画质和音轨",
        ) {
            Ok(()) => update(&store, &writer, &task.id, |current| {
                set_output_state(current, "media", 0, "succeeded", None);
                current.progress = media_span;
            }),
            Err(error) if error == "cancelled" => {
                mark_stopped(&store, &writer, &task.id);
                return;
            }
            Err(error) => {
                update(&store, &writer, &task.id, |current| {
                    current.state = "failed".into();
                    current.phase = "failed".into();
                    current.error = Some(error.clone());
                    current.message = Some("FFmpeg 无法处理所选媒体轨道".into());
                    set_output_state(current, "media", 0, "failed", Some(error));
                });
                return;
            }
        }
    }
    let subtitle_count = plan.subtitles.len();
    let mut subtitle_failures = 0;
    for (index, subtitle) in plan.subtitles.iter().enumerate() {
        let output_item = task
            .outputs
            .iter()
            .filter(|item| item.kind == "subtitle")
            .nth(index);
        if output_item.is_some_and(|item| {
            item.state == "succeeded"
                && item
                    .path
                    .as_deref()
                    .is_some_and(|path| Path::new(path).is_file())
        }) {
            continue;
        }
        let Some(path) = output_item.and_then(|item| item.path.clone()) else {
            subtitle_failures += 1;
            continue;
        };
        update(&store, &writer, &task.id, |current| {
            set_output_state(current, "subtitle", index, "running", None);
            current.message = Some(format!(
                "正在保存字幕：{}",
                subtitle
                    .label
                    .as_deref()
                    .or(subtitle.language.as_deref())
                    .unwrap_or("未命名")
            ));
        });
        let manifest_file = match write_named_manifest(
            &task.id,
            &format!("subtitle-{index}"),
            &subtitle.manifest,
        ) {
            Ok(file) => file,
            Err(error) => {
                subtitle_failures += 1;
                update(&store, &writer, &task.id, |current| {
                    set_output_state(
                        current,
                        "subtitle",
                        index,
                        "failed",
                        Some(error.to_string()),
                    )
                });
                continue;
            }
        };
        let mut args = ffmpeg_base_args();
        args.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
        append_ffmpeg_input(&mut args, &task, manifest_file.path());
        args.extend([
            "-map".into(),
            "0:s:0".into(),
            "-c:s".into(),
            "webvtt".into(),
            path,
        ]);
        let start = 90 + ((index * 10) / subtitle_count.max(1)) as u8;
        let span = (10 / subtitle_count.max(1)).max(1) as u8;
        match run_ffmpeg_with_progress(
            &store,
            &writer,
            &task,
            args,
            plan.duration,
            start,
            span,
            "正在下载字幕",
        ) {
            Ok(()) => update(&store, &writer, &task.id, |current| {
                set_output_state(current, "subtitle", index, "succeeded", None)
            }),
            Err(error) if error == "cancelled" => {
                mark_stopped(&store, &writer, &task.id);
                return;
            }
            Err(error) => {
                subtitle_failures += 1;
                update(&store, &writer, &task.id, |current| {
                    set_output_state(current, "subtitle", index, "failed", Some(error))
                });
            }
        }
    }
    update(&store, &writer, &task.id, |current| {
        current.progress = 100;
        current.active_connections = 0;
        current.speed_bytes_per_second = 0;
        current.eta_seconds = Some(0);
        current.downloaded_bytes = fs::metadata(&output)
            .map(|metadata| metadata.len())
            .unwrap_or(current.downloaded_bytes);
        current.total_bytes = Some(current.downloaded_bytes);
        if subtitle_failures == 0 {
            current.state = "succeeded".into();
            current.phase = "completed".into();
            current.error = None;
            current.message = Some("视频和字幕下载完成".into());
        } else {
            current.state = "partial".into();
            current.phase = "partial".into();
            current.error = Some("subtitle_output_failed".into());
            current.message = Some(format!("视频已完成，{subtitle_failures} 条字幕失败"));
        }
    });
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
        if task.hls_plan_version >= 2 {
            let plan = task.hls_plan.clone();
            start_hls_checkpoint_download(store, writer, task, output, plan);
            return;
        }
        if let Some(plan) = task.hls_plan.clone() {
            start_hls_plan_download(store, writer, task, output, plan);
            return;
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

fn resume_recoverable_hls_tasks(store: &Store, writer: &Writer) {
    let resumable: Vec<Task> = store
        .tasks
        .lock()
        .unwrap()
        .iter()
        .filter(|task| {
            task.hls_plan_version >= 2
                && task.state == "interrupted"
                && task.resume_requirement.is_none()
                && checkpoint_available(&checkpoint_path_for_store(store, &task.id))
        })
        .cloned()
        .filter_map(|mut task| {
            let checkpoint = load_checkpoint(&checkpoint_path_for_store(store, &task.id)).ok()?;
            task.hls_plan = Some(runtime_plan_from_persisted(&checkpoint.plan));
            Some(task)
        })
        .collect();
    for task in resumable {
        update(store, writer, &task.id, |current| {
            current.state = "retrying".into();
            current.phase = "recovering".into();
            current.attempt = current.attempt.saturating_add(1);
            current.error = None;
            current.message = Some("正在从 HLS 检查点自动恢复".into());
        });
        start_download(store.clone(), writer.clone(), task);
    }
}

fn start_recovery_once(store: &Store, writer: &Writer) {
    if store
        .recovery_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        resume_recoverable_hls_tasks(store, writer);
    }
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
        let message_type = message["type"].as_str().unwrap_or("");
        let response = match message_type {
            "host.info" => {
                json!({"version":1,"id":id,"ok":true,"protocolVersion":3,"supportedProtocolVersions":[2,3],"hostVersion":"0.9.0","capabilities":["inline-hls-v1","task-control-v1","task-pause-resume-v1","hls-selection-v1","hls-subtitle-sidecar-v1","task-output-group-v1","hls-segment-engine-v1","hls-checkpoint-v1","hls-aes128-v1","hls-key-override-v1","hls-reauthorize-v1"]})
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
        if matches!(message_type, "host.info" | "task.list") {
            start_recovery_once(&store, &writer);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_value(suffix: &str) -> Value {
        json!({
            "format":"hls",
            "text":format!("#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.test/{suffix}.ts\n#EXT-X-ENDLIST\n"),
            "baseUrl":"https://example.test/player"
        })
    }

    fn hls_payload(save_dir: Option<&Path>) -> Value {
        let mut payload = json!({
            "url":"https://example.test/master.m3u8",
            "title":"测试视频",
            "fileName":"测试视频",
            "mime":"application/vnd.apple.mpegurl",
            "sourceContextId":"source-context-a",
            "requestHeaders":{
                "cookie":"session=secret-cookie",
                "authorization":"Bearer secret-token",
                "referer":"https://example.test/page"
            },
            "hlsPlan":{
                "version":1,
                "duration":2.0,
                "container":"mkv",
                "videoManifest":manifest_value("video"),
                "audioManifest":manifest_value("audio"),
                "subtitles":[
                    {"language":"zh-CN","label":"中文一","extension":"vtt","manifest":manifest_value("sub-1")},
                    {"language":"zh-CN","label":"中文二","extension":"vtt","manifest":manifest_value("sub-2")}
                ]
            }
        });
        if let Some(dir) = save_dir {
            payload["saveDir"] = Value::String(dir.to_string_lossy().into_owned());
        }
        payload
    }
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
        assert!(task.outputs.is_empty());
        assert!(task.source_context_id.is_none());
        assert!(!task.hls_selection);
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
            source_context_id: None,
            outputs: Vec::new(),
            hls_selection: false,
            hls_plan_version: 0,
            failed_segments: 0,
            retry_count: 0,
            checkpoint_state: None,
            resume_requirement: None,
            requires_authorization: false,
            requires_key_override: false,
            source_candidate_id: None,
            inline_manifest: Some(InlineManifest {
                text: "#EXTM3U\n".into(),
                base_url: "https://example.test/".into(),
            }),
            hls_plan: None,
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
    fn hls_plan_validates_version_duration_container_and_subtitle_limit() {
        let valid = hls_payload(None);
        let plan = hls_plan(&valid).unwrap().unwrap();
        assert_eq!(plan.container, "mkv");
        assert_eq!(plan.subtitles.len(), 2);

        for (field, value, expected) in [
            ("version", json!(3), "hls_plan_version_unsupported"),
            ("duration", json!(0), "hls_plan_invalid"),
            ("container", json!("avi"), "hls_plan_invalid"),
        ] {
            let mut invalid = valid.clone();
            invalid["hlsPlan"][field] = value;
            assert_eq!(hls_plan(&invalid).unwrap_err(), expected);
        }

        let mut excessive = valid;
        excessive["hlsPlan"]["subtitles"] = Value::Array(
            (0..17)
                .map(|index| json!({"language":format!("s{index}"),"extension":"vtt","manifest":manifest_value("subtitle")}))
                .collect(),
        );
        assert_eq!(
            hls_plan(&excessive).unwrap_err(),
            "hls_plan_too_many_subtitles"
        );
    }
    #[test]
    fn hls_plan_v2_accepts_valid_key_override_and_v1_rejects_it() {
        let mut payload = hls_payload(None);
        payload["hlsPlan"]["version"] = json!(2);
        payload["hlsPlan"]["keyOverride"] = json!({
            "kind":"hex",
            "value":"00112233445566778899aabbccddeeff",
            "iv":"00000000000000000000000000000001"
        });
        let plan = hls_plan(&payload).unwrap().unwrap();
        assert_eq!(plan.version, 2);
        assert!(plan.key_override.is_some());

        payload["hlsPlan"]["version"] = json!(1);
        assert_eq!(
            hls_plan(&payload).unwrap_err(),
            "hls_plan_version_unsupported"
        );

        payload["hlsPlan"]["version"] = json!(2);
        payload["hlsPlan"]["keyOverride"]["value"] = json!("bad");
        assert_eq!(hls_plan(&payload).unwrap_err(), "hls_key_override_invalid");
    }
    #[test]
    fn hls_prepare_uses_selected_container_and_rejects_before_creating_save_dir() {
        let prepared = prepare_task(&hls_payload(None)).unwrap();
        assert_eq!(prepared["extension"], "mkv");

        let root =
            std::env::temp_dir().join(format!("streamfirefly-invalid-plan-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let save_dir = root.join("must-not-exist");
        let store = load_store(&root.join("tasks.json"));
        let mut invalid = hls_payload(Some(&save_dir));
        invalid["hlsPlan"]["duration"] = json!(0);
        assert_eq!(
            create_task(&store, &invalid).unwrap_err(),
            "hls_plan_invalid"
        );
        assert!(!save_dir.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn hls_task_keeps_public_outputs_but_strips_runtime_plan_and_credentials() {
        let root = std::env::temp_dir().join(format!("streamfirefly-hls-task-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let store = load_store(&root.join("tasks.json"));
        let task = create_task(&store, &hls_payload(Some(&root))).unwrap();
        assert_eq!(task.outputs.len(), 3);
        assert_ne!(task.outputs[1].path, task.outputs[2].path);
        assert!(task.outputs[2].path.as_deref().unwrap().contains("zh-CN-2"));

        let public = sanitized_task(&task);
        assert_eq!(
            public.source_context_id.as_deref(),
            Some("source-context-a")
        );
        assert_eq!(public.outputs.len(), 3);
        assert!(public.hls_selection);
        assert!(public.hls_plan.is_none());
        assert!(!public.request_headers.contains_key("cookie"));
        assert!(!public.request_headers.contains_key("authorization"));
        assert_eq!(
            public.request_headers["referer"],
            "https://example.test/page"
        );
        let serialized = serde_json::to_string(&public).unwrap();
        assert!(!serialized.contains("secret-cookie"));
        assert!(!serialized.contains("secret-token"));
        assert!(!serialized.contains("videoManifest"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restarted_hls_selection_task_loses_runtime_plan_and_interrupts_outputs() {
        let root =
            std::env::temp_dir().join(format!("streamfirefly-hls-restart-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("tasks.json");
        let store = load_store(&path);
        let created = create_task(&store, &hls_payload(Some(&root))).unwrap();
        drop(store);
        let reloaded = load_store(&path);
        let task = reloaded
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == created.id)
            .unwrap()
            .clone();
        assert_eq!(task.state, "interrupted");
        assert!(task.hls_plan.is_none());
        assert!(task.hls_selection);
        assert_eq!(
            ensure_restart_context(&reloaded, &task),
            Err("hls_plan_expired")
        );
        assert!(task
            .outputs
            .iter()
            .all(|output| output.state == "interrupted"));
        assert!(task.outputs.iter().any(|output| output.kind == "subtitle"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restarted_hls_v2_task_exposes_reauthorization_only_with_checkpoint() {
        let root =
            std::env::temp_dir().join(format!("streamfirefly-hls-v2-restart-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("tasks.json");
        let store = load_store(&path);
        let mut payload = hls_payload(Some(&root));
        payload["hlsPlan"]["version"] = json!(2);
        payload["candidateId"] = json!("candidate-a");
        let created = create_task(&store, &payload).unwrap();
        let checkpoint = new_checkpoint(&created.id, created.hls_plan.as_ref().unwrap()).unwrap();
        save_checkpoint(&checkpoint_path_for_store(&store, &created.id), &checkpoint).unwrap();
        drop(store);

        let reloaded = load_store(&path);
        let task = reloaded
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == created.id)
            .unwrap()
            .clone();
        assert_eq!(task.state, "interrupted");
        assert_eq!(task.checkpoint_state.as_deref(), Some("recoverable"));
        assert_eq!(
            task.resume_requirement.as_deref(),
            Some("authorization_required")
        );
        assert_eq!(task.source_candidate_id.as_deref(), Some("candidate-a"));
        assert_eq!(ensure_restart_context(&reloaded, &task), Ok(()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn retry_and_authorization_classification_is_bounded() {
        assert!(retryable_hls_error("http_status_429:retry_after=90"));
        assert!(retryable_hls_error("http_status_503"));
        assert!(!retryable_hls_error("http_status_404"));
        assert!(authorization_hls_error("http_status_401"));
        assert!(authorization_hls_error("http_status_403:retry_after=1"));
        assert_eq!(
            retry_after_seconds("http_status_429:retry_after=90"),
            Some(30)
        );
        assert_eq!(retry_after_seconds("http_status_500"), None);
    }
    #[test]
    fn ffmpeg_headers_are_scoped_to_each_input() {
        let task: Task = serde_json::from_value(json!({
            "id":"headers","url":"https://example.test/a.m3u8","title":"headers",
            "state":"queued","progress":0,"output":null,"error":null,"mime":"application/vnd.apple.mpegurl",
            "request_headers":{"referer":"https://example.test/page"}
        })).unwrap();
        let mut args = ffmpeg_base_args();
        append_ffmpeg_input(&mut args, &task, Path::new("video.m3u8"));
        append_ffmpeg_input(&mut args, &task, Path::new("audio.m3u8"));
        assert_eq!(
            args.iter()
                .filter(|value| value.as_str() == "-headers")
                .count(),
            2
        );
        assert_eq!(
            args.iter().filter(|value| value.as_str() == "-i").count(),
            2
        );
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
    #[test]
    fn delete_task_outputs_removes_media_and_all_subtitle_files_once() {
        let dir =
            std::env::temp_dir().join(format!("streamfirefly-delete-group-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let media = dir.join("video.mp4");
        let subtitle = dir.join("video.zh-CN.vtt");
        fs::write(&media, b"media").unwrap();
        fs::write(&subtitle, b"subtitle").unwrap();
        let task: Task = serde_json::from_value(json!({
            "id":"delete-group","url":"https://example.test/a.m3u8","title":"delete-group",
            "state":"partial","progress":100,"output":media,"error":"subtitle_output_failed","mime":"application/vnd.apple.mpegurl",
            "outputs":[
                {"kind":"media","path":media,"state":"succeeded"},
                {"kind":"subtitle","language":"zh-CN","path":subtitle,"state":"failed"}
            ]
        })).unwrap();
        assert_eq!(task_output_paths(&task).len(), 2);
        assert_eq!(delete_task_outputs(&task), Ok(true));
        assert!(!media.exists());
        assert!(!subtitle.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
