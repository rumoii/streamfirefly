mod hls;
mod protocol;
fn main() -> io::Result<()> {
    protocol::run()
}
mod model;
use model::*;
mod media_process;
use media_process::*;
mod hls_download;
use hls_download::*;
mod processes;
use processes::*;
mod http_download;
use http_download::*;
mod task_control;
use task_control::*;
mod task_store;
use task_store::*;
mod scheduler;
use scheduler::{remove_pending, scheduler_active, scheduler_full, start_download};

use hls::{
    decrypt_aes128, load_checkpoint, local_playlist, media_header_valid, merge_live_window,
    override_key_bytes, parse_key_override, parse_live_media_playlist,
    parse_live_media_playlist_after, parse_manifest_iv, parse_media_playlist, save_checkpoint,
    ByteRange, HlsCheckpoint, KeyOverride, KeyOverrideKind, KeySpec, PersistedManifest,
    PersistedPlan, PersistedSubtitlePlan, CHECKPOINT_VERSION,
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
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
const STORE_VERSION: u8 = 1;
const DEFAULT_DOWNLOAD_THREADS: u8 = 6;
const MAX_DOWNLOAD_THREADS: u8 = 16;
const INLINE_MANIFEST_MAX_BYTES: usize = 512 * 1024;
const SENSITIVE_REQUEST_HEADERS: [&str; 2] = ["cookie", "authorization"];

#[derive(Clone)]
struct Store {
    path: PathBuf,
    tasks: Arc<Mutex<Vec<Task>>>,
    processes: Arc<Mutex<HashMap<String, Vec<Arc<Mutex<Child>>>>>>,
    cancellations: Arc<Mutex<HashMap<String, bool>>>,
    pauses: Arc<Mutex<HashSet<String>>>,
    stops: Arc<Mutex<HashSet<String>>>,
    recovery_started: Arc<AtomicBool>,
    scheduler: Arc<Mutex<scheduler::Scheduler>>,
    persistence: Arc<Mutex<()>>,
    creation: Arc<Mutex<()>>,
    load_error: Option<String>,
    runtime_error: Arc<Mutex<Option<String>>>,
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
        live: value.live,
        poll_interval_seconds: value.poll_interval_seconds,
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
        live: value.live,
        poll_interval_seconds: value.poll_interval_seconds,
    }
}

fn new_checkpoint(task_id: &str, plan: &HlsPlan) -> Result<HlsCheckpoint, String> {
    let persisted = persisted_plan(plan);
    let parse = if plan.live {
        parse_live_media_playlist
    } else {
        parse_media_playlist
    };
    let mut tracks = vec![parse(
        "video",
        "video",
        None,
        None,
        &persisted.video_manifest,
    )?];
    if let Some(audio) = &persisted.audio_manifest {
        tracks.push(parse(
            "audio",
            "audio",
            None,
            Some("外部音轨".into()),
            audio,
        )?);
    }
    for (index, subtitle) in persisted.subtitles.iter().enumerate() {
        tracks.push(parse(
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

fn default_download_dir() -> PathBuf {
    state_path()
        .parent()
        .unwrap_or(Path::new("."))
        .join("downloads")
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
        .filter(|version| matches!(*version, 2 | 3))
        .ok_or("hls_plan_version_unsupported")? as u8;
    let live = version == 3;
    let duration = value["duration"]
        .as_f64()
        .filter(|value| value.is_finite() && (*value > 0.0 || live && *value >= 0.0))
        .ok_or("hls_plan_invalid")?;
    let poll_interval_seconds = value
        .get("pollIntervalSeconds")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 30));
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
        live,
        poll_interval_seconds,
    }))
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
    let _creation = store.creation.lock().unwrap();
    if store.load_error.is_some() {
        return Err("task_store_unavailable");
    }
    if let Some(request_id) = payload["requestId"].as_str() {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("request_id_invalid");
        }
        if let Some(task) = store
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.request_id.as_deref() == Some(request_id))
            .cloned()
        {
            return Ok(task);
        }
    }
    if payload["hlsPlan"]["version"].as_u64() == Some(3) && scheduler_full(store) {
        return Err("live_capacity_unavailable");
    }
    let inline_manifest = inline_manifest(payload)?;
    let hls_plan = hls_plan(payload)?;
    let hls_selection = hls_plan.is_some();
    if !hls_selection
        && (inline_manifest.is_some()
            || payload["url"]
                .as_str()
                .is_some_and(|url| url.to_ascii_lowercase().contains(".m3u8"))
            || payload["mime"]
                .as_str()
                .is_some_and(|mime| mime.contains("mpegurl")))
    {
        return Err("hls_plan_required");
    }
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
        revision: 1,
        request_id: payload["requestId"].as_str().map(str::to_owned),
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
        live_recording: hls_plan_version == 3,
        recorded_duration: 0.0,
        last_media_sequence: None,
        source_candidate_id: payload["candidateId"].as_str().map(str::to_string),
        inline_manifest,
        hls_plan,
    };
    if let Some(plan) = &task.hls_plan {
        let checkpoint = new_checkpoint(&task.id, plan).map_err(|_| "hls_checkpoint_invalid")?;
        save_checkpoint(&checkpoint_path_for_store(store, &task.id), &checkpoint)
            .map_err(|_| "task_store_write_failed")?;
    }
    tasks.push(task.clone());
    if persist_tasks(store, &tasks).is_err() {
        tasks.retain(|current| current.id != task.id);
        return Err("task_store_write_failed");
    }
    Ok(task)
}

fn update(store: &Store, writer: &Writer, id: &str, change: impl FnOnce(&mut Task)) {
    let mut tasks = store.tasks.lock().unwrap();
    let Some(index) = tasks.iter().position(|task| task.id == id) else {
        return;
    };
    change(&mut tasks[index]);
    tasks[index].revision = tasks[index].revision.saturating_add(1);
    if persist_tasks(store, &tasks).is_err() {
        emit(
            writer,
            json!({"version":1,"type":"task.persistence-error","id":id,"error":"task_store_write_failed"}),
        );
        return;
    }
    let public_task = sanitized_task(&tasks[index]);
    emit(
        writer,
        json!({"version":1,"type":"task.progress","task":public_task}),
    );
}

fn run_download(store: Store, writer: Writer, task: Task) {
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
    if task.hls_selection
        || task.inline_manifest.is_some()
        || task.url.to_ascii_lowercase().contains(".m3u8")
        || task.mime.as_deref().unwrap_or("").contains("mpegurl")
    {
        update(&store, &writer, &task.id, |task| {
            task.state = "failed".into();
            task.phase = "failed".into();
            task.error = Some("hls_plan_required".into());
            task.message = Some("请重新解析 HLS 并创建切片下载任务".into());
        });
        return;
    }
    let is_stream = task.url.to_ascii_lowercase().contains(".mpd")
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
        task.url.clone(),
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
                    t.downloaded_bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(bytes);
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
}

fn resume_recoverable_hls_tasks(store: &Store, writer: &Writer) {
    let resumable: Vec<Task> = store
        .tasks
        .lock()
        .unwrap()
        .iter()
        .filter(|task| {
            task.state == "interrupted"
                && !task.live_recording
                && task.resume_requirement.is_none()
                && (!task.hls_selection
                    || checkpoint_available(&checkpoint_path_for_store(store, &task.id)))
        })
        .cloned()
        .collect();
    for mut task in resumable {
        if task.hls_selection {
            let Ok(checkpoint) = load_checkpoint(&checkpoint_path_for_store(store, &task.id))
            else {
                continue;
            };
            task.hls_plan = Some(runtime_plan_from_persisted(&checkpoint.plan));
        }
        update(store, writer, &task.id, |current| {
            current.state = "queued".into();
            current.phase = "recovering".into();
            current.hls_plan = task.hls_plan.clone();
            current.attempt = current.attempt.saturating_add(1);
            current.error = None;
            current.message = Some("已重新排队，等待恢复下载".into());
        });
        task.state = "queued".into();
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
                "version":2,
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
            revision: 1,
            request_id: None,
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
            live_recording: false,
            recorded_duration: 0.0,
            last_media_sequence: None,
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
            ("version", json!(4), "hls_plan_version_unsupported"),
            ("duration", json!(0), "hls_plan_invalid"),
            ("container", json!("avi"), "hls_plan_invalid"),
        ] {
            let mut invalid = valid.clone();
            invalid["hlsPlan"][field] = value;
            assert_eq!(hls_plan(&invalid).unwrap_err(), expected);
        }

        let mut live = valid.clone();
        live["hlsPlan"]["version"] = json!(3);
        live["hlsPlan"]["duration"] = json!(0);
        live["hlsPlan"]["pollIntervalSeconds"] = json!(2);
        let live = hls_plan(&live).unwrap().unwrap();
        assert!(live.live);
        assert_eq!(live.poll_interval_seconds, Some(2));

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
    fn queued_hls_task_persists_a_recoverable_plan_before_execution() {
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
        assert_eq!(ensure_restart_context(&reloaded, &task), Ok(()));
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
