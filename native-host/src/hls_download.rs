use crate::hls::decrypt_aes128;
use crate::hls::load_checkpoint;
use crate::hls::local_playlist;
use crate::hls::media_header_valid;
use crate::hls::merge_live_window;
use crate::hls::override_key_bytes;
use crate::hls::parse_live_media_playlist_after;
use crate::hls::parse_manifest_iv;
use crate::hls::save_checkpoint;
use crate::hls::ByteRange;
use crate::hls::HlsCheckpoint;
use crate::hls::KeyOverride;
use crate::hls::KeyOverrideKind;
use crate::hls::KeySpec;
use crate::hls::PersistedManifest;
use crate::hls_plan::new_checkpoint;
use crate::hls_plan::runtime_plan_from_persisted;
use crate::media_process::run_ffmpeg_with_progress;
use crate::media_process::set_output_state;
use crate::model::HlsPlan;
use crate::model::Task;
use crate::paths::checkpoint_available;
use crate::paths::checkpoint_path_for_state;
use crate::paths::task_work_root_for_state;
use crate::processes::cancel_requested;
use crate::processes::clear_stop;
use crate::processes::mark_stopped;
use crate::processes::stop_process;
use crate::processes::stop_requested;
use crate::processes::unregister_all_processes;
use crate::repository::is_sensitive_request_header;
use crate::runtime::TaskRuntime;
use crate::segment_transfer::{
    authorization_error, curl_once, retry_after_seconds, retryable_error, wait_retry,
};
use crate::task_state::update;
use crate::task_input::publish_task_output;
use crate::wire::Writer;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct HlsDownloadJob {
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

pub(crate) struct HlsDownloadResult {
    job: HlsDownloadJob,
    bytes: u64,
    retries: u32,
    error: Option<String>,
}

pub(crate) fn load_hls_key(
    store: &TaskRuntime,
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
    let result = curl_once(store, task, url, None, &key_file, abort);
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

pub(crate) fn execute_hls_job(
    store: &TaskRuntime,
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
        let attempt = curl_once(
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
            Err(error) if retryable_error(&error) && retries < 3 => {
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

pub(crate) fn checkpoint_counts(checkpoint: &HlsCheckpoint) -> (u32, u32, u32, u32, u64) {
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

pub(crate) fn checkpoint_jobs(
    checkpoint: &mut HlsCheckpoint,
    work_dir: &Path,
) -> Vec<HlsDownloadJob> {
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

pub(crate) fn apply_hls_result(checkpoint: &mut HlsCheckpoint, result: &HlsDownloadResult) {
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

pub(crate) fn publish_hls_progress(
    store: &TaskRuntime,
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

pub(crate) fn merge_hls_checkpoint(
    store: &TaskRuntime,
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
        let output_path = Path::new(output);
        let temporary = work_dir.join(format!(
            "media-publish.{}",
            output_path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("mp4")
        ));
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
        // The primary playlist may carry audio only, so its video stream is optional.
        args.extend([
            "-map".into(),
            "0:v:0?".into(),
            "-map".into(),
            if audio_playlist.is_some() {
                "1:a:0"
            } else {
                "0:a?"
            }
            .into(),
            "-c".into(),
            "copy".into(),
            temporary.to_string_lossy().into_owned(),
        ]);
        match run_ffmpeg_with_progress(
            store,
            writer,
            task,
            args,
            &temporary,
            checkpoint.plan.duration,
            90,
            10,
            "切片下载完成，正在无转码合并",
        ) {
            Ok(()) => {
                let published = {
                    let tasks = store.repository.tasks.lock().unwrap();
                    publish_task_output(&temporary, output_path, &tasks, &task.id)
                };
                match published {
                    Ok(()) => update(store, writer, &task.id, |current| {
                        set_output_state(current, "media", 0, "succeeded", None)
                    }),
                    Err(error) => {
                        update(store, writer, &task.id, |current| {
                            set_output_state(current, "media", 0, "failed", Some(error.into()))
                        });
                        return Err(error.into());
                    }
                }
            }
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
        let temporary = work_dir.join(format!("subtitle-publish-{subtitle_index}.vtt"));
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
            temporary.to_string_lossy().into_owned(),
        ];
        let start = 90 + ((subtitle_index * 10) / subtitle_count.max(1)) as u8;
        let span = (10 / subtitle_count.max(1)).max(1) as u8;
        match run_ffmpeg_with_progress(
            store,
            writer,
            task,
            args,
            &temporary,
            subtitle.duration,
            start,
            span,
            "正在生成字幕文件",
        ) {
            Ok(()) => {
                let published = {
                    let tasks = store.repository.tasks.lock().unwrap();
                    publish_task_output(&temporary, Path::new(&path), &tasks, &task.id)
                };
                match published {
                    Ok(()) => update(store, writer, &task.id, |current| {
                        set_output_state(current, "subtitle", subtitle_index, "succeeded", None)
                    }),
                    Err(error) => {
                        subtitle_failures += 1;
                        update(store, writer, &task.id, |current| {
                            set_output_state(
                                current,
                                "subtitle",
                                subtitle_index,
                                "failed",
                                Some(error.into()),
                            )
                        });
                    }
                }
            }
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

/// Runs a checkpointed HLS download on the scheduler-owned thread; live recordings poll in this same loop.
pub(crate) fn start_hls_checkpoint_download(
    store: TaskRuntime,
    writer: Writer,
    task: Task,
    output: String,
    runtime_plan: Option<HlsPlan>,
) {
    let mut next = Some((task, runtime_plan));
    while let Some((task, runtime_plan)) = next.take() {
        next = hls_checkpoint_round(&store, &writer, task, &output, runtime_plan);
    }
}

/// Returns the refreshed task and plan when a live recording must continue with another round.
fn hls_checkpoint_round(
    store: &TaskRuntime,
    writer: &Writer,
    task: Task,
    output: &str,
    runtime_plan: Option<HlsPlan>,
) -> Option<(Task, Option<HlsPlan>)> {
    let store = store.clone();
    let writer = writer.clone();
    let output = output.to_string();
    let work_dir = task_work_root_for_state(&store.repository.path).join(&task.id);
    let checkpoint_file = checkpoint_path_for_state(&store.repository.path, &task.id);
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
                return None;
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
                                "hls_live_not_supported" => "当前计划不支持直播 HLS",
                                "hls_map_iv_required" => "加密初始化片段缺少显式 IV",
                                "hls_encryption_unsupported" => "HLS 使用了暂不支持的加密方式",
                                _ => "无法准备 HLS 切片检查点",
                            }
                            .into(),
                        );
                        current.checkpoint_state = Some("invalid".into());
                    });
                    return None;
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
                return None;
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
        return None;
    }
    if task.requires_key_override && key_override.is_none() {
        update(&store, &writer, &task.id, |current| {
            current.state = "interrupted".into();
            current.phase = "key_required".into();
            current.resume_requirement = Some("key_required".into());
            current.message = Some("请重新输入自定义密钥后继续下载".into());
        });
        return None;
    }
    let mut checkpoint = checkpoint;
    if task.live_recording && !stop_requested(&store, &task.id) {
        if let Err(error) = refresh_live_checkpoint(&store, &task, &mut checkpoint, &work_dir) {
            let authorization = authorization_error(&error);
            update(&store, &writer, &task.id, |current| {
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
                current.checkpoint_state = Some("recoverable".into());
                current.resume_requirement = authorization.then(|| "authorization_required".into());
                current.message = Some("无法读取最新直播清单，可重试继续录制".into());
            });
            return None;
        }
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
            return None;
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
                return None;
            }
        }
        if let Some(error) = result.error {
            if error == "cancelled" {
                mark_stopped(&store, &writer, &task.id);
                return None;
            }
            update(&store, &writer, &task.id, |current| {
                if authorization_error(&error) {
                    current.requires_authorization = true;
                }
                current.state = if authorization_error(&error) {
                    "interrupted"
                } else {
                    "failed"
                }
                .into();
                current.phase = if authorization_error(&error) {
                    "authorization_required"
                } else {
                    "failed"
                }
                .into();
                current.error = Some(error.clone());
                current.active_connections = 0;
                current.checkpoint_state = Some("recoverable".into());
                current.resume_requirement =
                    authorization_error(&error).then(|| "authorization_required".into());
                current.message = Some(if error == "hls_key_validation_failed" {
                    "AES-128 密钥验证失败，尚未开始批量下载".into()
                } else if authorization_error(&error) {
                    "资源授权已经失效，请从来源页面重新授权".into()
                } else {
                    "无法验证首个加密切片".into()
                });
            });
            return None;
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
        return None;
    }
    if let Some(error) = failure {
        let authorization = authorization_error(&error);
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
        return None;
    }
    if task.live_recording && !stop_requested(&store, &task.id) {
        let poll_seconds = {
            let checkpoint = checkpoint.lock().unwrap();
            let video = checkpoint.tracks.iter().find(|track| track.kind == "video");
            if video.is_some_and(|track| track.end_list) {
                0
            } else {
                runtime_plan
                    .poll_interval_seconds
                    .or_else(|| {
                        video
                            .and_then(|track| track.target_duration)
                            .map(|seconds| (seconds / 2.0).ceil() as u64)
                    })
                    .unwrap_or(3)
                    .clamp(1, 30)
            }
        };
        if poll_seconds > 0 {
            let checkpoint_value = checkpoint.lock().unwrap().clone();
            let video = checkpoint_value
                .tracks
                .iter()
                .find(|track| track.kind == "video");
            update(&store, &writer, &task.id, |current| {
                current.state = "running".into();
                current.phase = "recording".into();
                current.progress = 0;
                current.active_connections = 0;
                current.eta_seconds = None;
                current.recorded_duration = video.map(|track| track.duration).unwrap_or(0.0);
                current.last_media_sequence = video
                    .and_then(|track| track.segments.last())
                    .map(|segment| segment.sequence);
                current.message = Some("直播录制中，正在等待新的媒体切片".into());
            });
            for _ in 0..poll_seconds * 10 {
                if cancel_requested(&store, &task.id) {
                    mark_stopped(&store, &writer, &task.id);
                    return None;
                }
                if stop_requested(&store, &task.id) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if !stop_requested(&store, &task.id) {
                let refreshed = {
                    let mut checkpoint = checkpoint.lock().unwrap();
                    let result = refresh_live_checkpoint(&store, &task, &mut checkpoint, &work_dir);
                    if result.is_ok() {
                        let _ = save_checkpoint(&checkpoint_file, &checkpoint);
                    }
                    result
                };
                if let Err(error) = refreshed {
                    let authorization = authorization_error(&error);
                    update(&store, &writer, &task.id, |current| {
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
                        current.checkpoint_state = Some("recoverable".into());
                        current.resume_requirement =
                            authorization.then(|| "authorization_required".into());
                        current.message = Some(if authorization {
                            "直播授权已经失效，请从来源页面重新授权".into()
                        } else {
                            "直播清单刷新失败，可重试继续录制".into()
                        });
                    });
                    return None;
                }
            }
            let next_task = store
                .repository
                .tasks
                .lock()
                .unwrap()
                .iter()
                .find(|current| current.id == task.id)
                .cloned()
                .map(|mut current| {
                    current.hls_plan = Some(runtime_plan.clone());
                    current
                })
                .unwrap_or(task.clone());
            return Some((next_task, Some(runtime_plan)));
        }
    }
    let checkpoint_value = checkpoint.lock().unwrap().clone();
    let final_video = checkpoint_value
        .tracks
        .iter()
        .find(|track| track.kind == "video");
    update(&store, &writer, &task.id, |current| {
        current.phase = "merging".into();
        current.active_connections = 0;
        current.progress = 90;
        if task.live_recording {
            current.recorded_duration = final_video.map(|track| track.duration).unwrap_or(0.0);
            current.last_media_sequence = final_video
                .and_then(|track| track.segments.last())
                .map(|segment| segment.sequence);
        }
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
                current.message = Some(if task.live_recording {
                    "直播录制已停止并保存".into()
                } else {
                    "HLS 视频和所选字幕下载完成".into()
                });
            });
            clear_stop(&store, &task.id);
        }
        Ok(subtitle_failures) => update(&store, &writer, &task.id, |current| {
            let conflict = current.outputs.iter().any(|output| {
                output.kind == "subtitle" && output.error.as_deref() == Some("output_path_conflict")
            });
            current.state = "partial".into();
            current.phase = "partial".into();
            current.progress = 100;
            current.active_connections = 0;
            current.eta_seconds = Some(0);
            current.checkpoint_state = Some("recoverable".into());
            current.error = Some(
                if conflict {
                    "output_path_conflict"
                } else {
                    "subtitle_output_failed"
                }
                .into(),
            );
            current.message = Some(if conflict {
                "输出文件已存在或被其他任务占用，请保留原文件并新建任务。".into()
            } else {
                format!("视频已完成，{subtitle_failures} 条字幕生成失败，可重试")
            });
        }),
        Err(error) if error == "cancelled" => mark_stopped(&store, &writer, &task.id),
        Err(error) => update(&store, &writer, &task.id, |current| {
            current.state = "failed".into();
            current.phase = "failed".into();
            current.error = Some(error.clone());
            current.checkpoint_state = Some("recoverable".into());
            current.message = Some(if error == "output_path_conflict" {
                "输出文件已存在或被其他任务占用，请保留原文件并新建任务。".into()
            } else {
                "切片已保存，但 FFmpeg 合并失败".into()
            });
        }),
    }
    None
}

pub(crate) fn fetch_live_manifest(
    store: &TaskRuntime,
    task: &Task,
    url: &str,
    destination: &Path,
) -> Result<PersistedManifest, String> {
    let abort = AtomicBool::new(false);
    let mut retries = 0;
    loop {
        match curl_once(store, task, url, None, destination, &abort) {
            Ok(_) => break,
            Err(error) if retryable_error(&error) && retries < 3 => {
                retries += 1;
                if !wait_retry(
                    store,
                    &task.id,
                    &abort,
                    retry_after_seconds(&error).unwrap_or(retries),
                ) {
                    return Err("cancelled".into());
                }
            }
            Err(error) => return Err(error),
        }
    }
    let text = fs::read_to_string(destination).map_err(|error| error.to_string())?;
    let _ = fs::remove_file(destination);
    Ok(PersistedManifest {
        text,
        base_url: url.to_string(),
    })
}

pub(crate) fn refresh_live_checkpoint(
    store: &TaskRuntime,
    task: &Task,
    checkpoint: &mut HlsCheckpoint,
    work_dir: &Path,
) -> Result<usize, String> {
    let sources: Vec<(usize, PersistedManifest)> = checkpoint
        .tracks
        .iter()
        .enumerate()
        .filter_map(|(index, track)| {
            let manifest =
                match track.kind.as_str() {
                    "video" => Some(checkpoint.plan.video_manifest.clone()),
                    "audio" => checkpoint.plan.audio_manifest.clone(),
                    "subtitle" => checkpoint
                        .plan
                        .subtitles
                        .iter()
                        .nth(index.saturating_sub(
                            1 + usize::from(checkpoint.plan.audio_manifest.is_some()),
                        ))
                        .map(|subtitle| subtitle.manifest.clone()),
                    _ => None,
                }?;
            Some((index, manifest))
        })
        .collect();
    let mut added = 0;
    for (index, source) in sources {
        let track = &checkpoint.tracks[index];
        let manifest = fetch_live_manifest(
            store,
            task,
            &source.base_url,
            &work_dir.join(format!("playlist-{index}.m3u8")),
        )?;
        let window = parse_live_media_playlist_after(track, &manifest)?;
        added += merge_live_window(&mut checkpoint.tracks[index], window)?;
        match checkpoint.tracks[index].kind.as_str() {
            "video" => checkpoint.plan.video_manifest = manifest,
            "audio" => checkpoint.plan.audio_manifest = Some(manifest),
            "subtitle" => {
                let subtitle_index =
                    index.saturating_sub(1 + usize::from(checkpoint.plan.audio_manifest.is_some()));
                if let Some(subtitle) = checkpoint.plan.subtitles.get_mut(subtitle_index) {
                    subtitle.manifest = manifest;
                }
            }
            _ => {}
        }
    }
    checkpoint.plan.duration = checkpoint
        .tracks
        .iter()
        .find(|track| track.kind == "video")
        .map(|track| track.duration)
        .unwrap_or(0.0);
    Ok(added)
}
