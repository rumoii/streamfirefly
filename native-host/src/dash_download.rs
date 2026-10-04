use crate::dash::{DashPlan, DashResource};
use crate::media_process::{run_ffmpeg_with_progress, set_output_state};
use crate::model::Task;
use crate::paths::task_work_root_for_state;
use crate::processes::{cancel_requested, mark_stopped};
use crate::runtime::TaskRuntime;
use crate::segment_transfer::{curl_once, retry_after_seconds, retryable_error, wait_retry};
use crate::task_state::update;
use crate::wire::Writer;
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

fn download_resource(
    store: &TaskRuntime,
    writer: &Writer,
    task: &Task,
    resource: &DashResource,
    destination: &Path,
    abort: &AtomicBool,
) -> Result<u64, String> {
    if let Ok(metadata) = fs::metadata(destination) {
        if metadata.len() > 0
            && resource
                .range
                .as_ref()
                .is_none_or(|range| metadata.len() == range.length)
        {
            return Ok(metadata.len());
        }
    }
    let mut retries = 0;
    loop {
        if abort.load(Ordering::Relaxed) || cancel_requested(store, &task.id) {
            return Err("cancelled".into());
        }
        match curl_once(
            store,
            task,
            &resource.url,
            resource.range.as_ref(),
            destination,
            abort,
        ) {
            Ok((bytes, _)) if bytes > 0 => return Ok(bytes),
            Ok(_) => return Err("dash_empty_segment".into()),
            Err(error) if retries < 3 && retryable_error(&error) => {
                retries += 1;
                update(store, writer, &task.id, |current| {
                    current.retry_count += 1;
                });
                if !wait_retry(
                    store,
                    &task.id,
                    abort,
                    retry_after_seconds(&error).unwrap_or(1 << (retries - 1)),
                ) {
                    return Err("cancelled".into());
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn assemble(
    store: &TaskRuntime,
    task: &Task,
    parts: &[PathBuf],
    destination: &Path,
) -> Result<(), String> {
    let mut output = fs::File::create(destination).map_err(|error| error.to_string())?;
    let mut buffer = [0u8; 65536];
    for part in parts {
        let mut input = fs::File::open(part).map_err(|error| error.to_string())?;
        loop {
            if cancel_requested(store, &task.id) {
                return Err("cancelled".into());
            }
            let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| error.to_string())?;
        }
    }
    output.sync_all().map_err(|error| error.to_string())
}

fn execute(
    store: &TaskRuntime,
    writer: &Writer,
    task: &Task,
    plan: &DashPlan,
    output: &str,
    work: &Path,
) -> Result<(), String> {
    fs::create_dir_all(work).map_err(|error| error.to_string())?;
    let mut jobs = Vec::new();
    let mut tracks = Vec::new();
    for (track_index, track) in plan.tracks.iter().enumerate() {
        let mut paths = Vec::new();
        if let Some(initialization) = &track.initialization {
            let destination = work.join(format!("{track_index}-init.part"));
            jobs.push((initialization.clone(), destination.clone()));
            paths.push(destination);
        }
        for (index, segment) in track.segments.iter().enumerate() {
            let destination = work.join(format!("{track_index}-{index}.part"));
            jobs.push((segment.resource.clone(), destination.clone()));
            paths.push(destination);
        }
        tracks.push(paths);
    }
    update(store, writer, &task.id, |current| {
        current.state = "running".into();
        current.phase = "downloading_segments".into();
        current.segments_total = jobs.len() as u32;
        current.segments_completed = 0;
        current.failed_segments = 0;
        current.downloaded_bytes = 0;
        current.active_connections = usize::from(task.download_threads).min(jobs.len()) as u8;
        current.message = Some("正在下载所选 DASH 轨道".into());
        set_output_state(current, "media", 0, "running", None);
    });
    let abort = AtomicBool::new(false);
    let mut transfer_task = task.clone();
    transfer_task.dash_plan = None;
    let mut anonymous_task = transfer_task.clone();
    anonymous_task
        .request_headers
        .retain(|name, _| !crate::repository::is_sensitive_request_header(name));
    let origin = url::Url::parse(&plan.base_url)
        .map_err(|_| "dash_url_invalid")?
        .origin();
    let next = AtomicUsize::new(0);
    let started = Instant::now();
    let result = thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel();
        for _worker in 0..usize::from(task.download_threads).min(jobs.len()) {
            let sender = sender.clone();
            let jobs = &jobs;
            let next = &next;
            let abort = &abort;
            let transfer_task = &transfer_task;
            let anonymous_task = &anonymous_task;
            let origin = &origin;
            scope.spawn(move || loop {
                if abort.load(Ordering::Relaxed) || cancel_requested(store, &task.id) {
                    break;
                }
                let index = next.fetch_add(1, Ordering::Relaxed);
                let Some((resource, destination)) = jobs.get(index) else {
                    break;
                };
                let scoped_task =
                    if url::Url::parse(&resource.url).is_ok_and(|url| &url.origin() == origin) {
                        transfer_task
                    } else {
                        anonymous_task
                    };
                let result =
                    download_resource(store, writer, scoped_task, resource, destination, abort);
                let failed = result.is_err();
                if sender.send(result).is_err() {
                    break;
                }
                if failed {
                    abort.store(true, Ordering::Relaxed);
                    break;
                }
            });
        }
        drop(sender);
        let mut first_error = None;
        let mut completed = 0_u32;
        let mut bytes = 0_u64;
        let mut published = 0_u32;
        let mut last_update = Instant::now();
        // Progress is summarised at most every 250 ms instead of rewriting the task store per segment.
        let publish = |completed: u32, bytes: u64| {
            update(store, writer, &task.id, |current| {
                current.segments_completed = completed;
                current.downloaded_bytes = bytes;
                current.progress = (u64::from(completed) * 85 / jobs.len() as u64) as u8;
                current.speed_bytes_per_second =
                    (bytes as f64 / started.elapsed().as_secs_f64().max(0.001)) as u64;
            })
        };
        for result in receiver {
            match result {
                Ok(segment_bytes) => {
                    completed += 1;
                    bytes += segment_bytes;
                    if last_update.elapsed() >= Duration::from_millis(250)
                        || completed as usize == jobs.len()
                    {
                        publish(completed, bytes);
                        published = completed;
                        last_update = Instant::now();
                    }
                }
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        if published != completed {
            publish(completed, bytes);
        }
        first_error.map_or(Ok(()), Err)
    });
    update(store, writer, &task.id, |current| {
        current.active_connections = 0;
    });
    result?;
    if cancel_requested(store, &task.id) {
        return Err("cancelled".into());
    }
    let mut args: Vec<String> = [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    for (index, parts) in tracks.iter().enumerate() {
        let destination = work.join(format!("track-{index}.media"));
        assemble(store, task, parts, &destination)?;
        args.extend([
            "-protocol_whitelist".into(),
            "file".into(),
            "-format_whitelist".into(),
            "mov,matroska,webm,mpegts,aac,mp3".into(),
            "-itsoffset".into(),
            plan.tracks[index].segments[0].time.to_string(),
            "-i".into(),
            destination.to_string_lossy().into(),
        ]);
    }
    for (index, track) in plan.tracks.iter().enumerate() {
        args.extend([
            "-map".into(),
            format!(
                "{index}:{}:0",
                if track.kind == "audio" { "a" } else { "v" }
            ),
        ]);
    }
    let temporary = work.join(format!("merged.{}", plan.container));
    args.extend([
        "-c".into(),
        "copy".into(),
        temporary.to_string_lossy().into(),
    ]);
    run_ffmpeg_with_progress(
        store,
        writer,
        task,
        args,
        plan.duration,
        85,
        14,
        "正在无转码合并 DASH 轨道",
    )?;
    if cancel_requested(store, &task.id) {
        return Err("cancelled".into());
    }
    if fs::metadata(&temporary)
        .map_err(|error| error.to_string())?
        .len()
        == 0
    {
        return Err("dash_output_empty".into());
    }
    let destination = Path::new(output);
    let staging = destination.with_extension(format!("{}.staging", task.id));
    let copied = assemble(store, task, &[temporary], &staging);
    if let Err(error) = copied {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    if cancel_requested(store, &task.id) {
        let _ = fs::remove_file(&staging);
        return Err("cancelled".into());
    }
    if let Err(error) = fs::rename(&staging, destination) {
        let _ = fs::remove_file(&staging);
        return Err(error.to_string());
    }
    Ok(())
}

pub(crate) fn start_dash_download(store: TaskRuntime, writer: Writer, task: Task, output: String) {
    let work = task_work_root_for_state(&store.repository.path)
        .join(&task.id)
        .join("dash");
    let result = match &task.dash_plan {
        Some(plan) => execute(&store, &writer, &task, plan, &output, &work),
        None => Err("dash_plan_expired".into()),
    };
    if cancel_requested(&store, &task.id) {
        mark_stopped(&store, &writer, &task.id);
        return;
    }
    match result {
        Ok(()) => {
            let cleanup = fs::remove_dir_all(&work);
            update(&store, &writer, &task.id, |current| {
                current.state = "succeeded".into();
                current.phase = "completed".into();
                current.progress = 100;
                current.speed_bytes_per_second = 0;
                current.eta_seconds = None;
                current.error = None;
                current.downloaded_bytes = fs::metadata(&output)
                    .map(|metadata| metadata.len())
                    .unwrap_or(0);
                current.total_bytes = Some(current.downloaded_bytes);
                current.message = Some(
                    if cleanup.is_ok() {
                        "DASH 下载完成"
                    } else {
                        "DASH 下载完成，临时文件清理失败，可删除任务记录清理"
                    }
                    .into(),
                );
                set_output_state(current, "media", 0, "succeeded", None);
            });
        }
        Err(error) => update(&store, &writer, &task.id, |current| {
            current.state = "failed".into();
            current.phase = "failed".into();
            current.error = Some(error.clone());
            current.active_connections = 0;
            current.speed_bytes_per_second = 0;
            current.failed_segments = current
                .segments_total
                .saturating_sub(current.segments_completed);
            current.message = Some("DASH 下载失败；同一助手进程内重试会保留已完成分片".into());
            set_output_state(current, "media", 0, "failed", Some(error));
        }),
    }
}
