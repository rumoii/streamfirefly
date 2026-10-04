use crate::model::Task;
use crate::processes::cancel_requested;
use crate::processes::pause_requested;
use crate::processes::mark_stopped;
use crate::processes::register_process;
use crate::processes::stop_process;
use crate::processes::unregister_process;
use crate::runtime::TaskRuntime;
use crate::settings::MAX_DOWNLOAD_THREADS;
use crate::task_state::update;
use crate::wire::Writer;
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::Read;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

#[derive(Default, Clone, Copy)]
pub(crate) struct ProbeInfo {
    total: Option<u64>,
    accept_ranges: bool,
    cancelled: bool,
}

pub(crate) fn add_header_args(args: &mut Vec<String>, task: &Task) {
    for (name, value) in &task.request_headers {
        args.push("--header".into());
        args.push(format!("{name}: {value}"));
    }
}

pub(crate) fn add_request_args(args: &mut Vec<String>, task: &Task, url: &str) {
    crate::network::add_proxy_args(args, &task.network, url);
    add_header_args(args, task);
}

pub(crate) fn probe_size(store: &TaskRuntime, task: &Task) -> ProbeInfo {
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
    add_request_args(&mut args, task, &task.url);
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

pub(crate) fn start_single_http_download(
    store: TaskRuntime,
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
    add_request_args(&mut args, &task, &task.url);
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

pub(crate) fn parallel_part_dir(output: &str, task_id: &str) -> PathBuf {
    PathBuf::from(format!("{output}.streamfirefly-parts-{task_id}"))
}

struct PartTransfer {
    part: PathBuf,
    length: u64,
    continuation: PathBuf,
    child: Option<Arc<Mutex<Child>>>,
}

fn part_bytes(transfer: &PartTransfer) -> u64 {
    fs::metadata(&transfer.part).map(|m| m.len()).unwrap_or(0)
        + fs::metadata(&transfer.continuation)
            .map(|m| m.len())
            .unwrap_or(0)
}

/// Appends the bytes a range request delivered after the part's existing prefix; curl writes them contiguously.
fn absorb_continuation(transfer: &PartTransfer) -> io::Result<()> {
    if !transfer.continuation.is_file() {
        return Ok(());
    }
    let mut destination = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&transfer.part)?;
    io::copy(&mut fs::File::open(&transfer.continuation)?, &mut destination)?;
    drop(destination);
    fs::remove_file(&transfer.continuation)
}

pub(crate) fn start_parallel_http_download(
    store: TaskRuntime,
    writer: Writer,
    task: Task,
    output: String,
    total: u64,
) -> bool {
    let count = usize::from(task.download_threads.clamp(2, MAX_DOWNLOAD_THREADS));
    let part_dir = parallel_part_dir(&output, &task.id);
    // Parts from a paused run are reused only when they were split for the same size and connection count.
    let layout_file = part_dir.join("layout");
    let layout = format!("{total}:{count}");
    if fs::read_to_string(&layout_file).ok().as_deref() != Some(layout.as_str()) {
        let _ = fs::remove_dir_all(&part_dir);
        if fs::create_dir_all(&part_dir).is_err() || fs::write(&layout_file, &layout).is_err() {
            let _ = fs::remove_dir_all(&part_dir);
            return false;
        }
    }
    let ranges: Vec<(u64, u64)> = (0..count)
        .map(|index| {
            let start = total * index as u64 / count as u64;
            let end = total * (index as u64 + 1) / count as u64 - 1;
            (start, end)
        })
        .collect();
    let mut transfers = Vec::new();
    for (index, (start, end)) in ranges.iter().enumerate() {
        let mut transfer = PartTransfer {
            part: part_dir.join(format!("{index:04}.part")),
            length: end - start + 1,
            continuation: part_dir.join(format!("{index:04}.next")),
            child: None,
        };
        if absorb_continuation(&transfer).is_err() {
            let _ = fs::remove_file(&transfer.part);
            let _ = fs::remove_file(&transfer.continuation);
        }
        let mut existing = fs::metadata(&transfer.part).map(|m| m.len()).unwrap_or(0);
        if existing > transfer.length {
            let _ = fs::remove_file(&transfer.part);
            existing = 0;
        }
        if existing < transfer.length {
            let mut args = vec![
                "--silent".into(),
                "--show-error".into(),
                "--fail".into(),
                "--location".into(),
                "--retry".into(),
                "3".into(),
                "--retry-all-errors".into(),
                "--range".into(),
                format!("{}-{end}", start + existing),
                "--output".into(),
                transfer.continuation.to_string_lossy().into(),
            ];
            add_request_args(&mut args, &task, &task.url);
            args.push(task.url.clone());
            match Command::new("curl")
                .args(args)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => transfer.child = Some(register_process(&store, &task.id, child)),
                Err(_) => {
                    stop_process(&store, &task.id);
                    let _ = fs::remove_dir_all(&part_dir);
                    return false;
                }
            }
        }
        transfers.push(transfer);
    }
    let initial_bytes: u64 = transfers.iter().map(part_bytes).sum();
    update(&store, &writer, &task.id, |t| {
        t.state = "running".into();
        t.phase = "downloading".into();
        t.total_bytes = Some(total);
        t.downloaded_bytes = initial_bytes;
        t.active_connections = transfers.iter().filter(|item| item.child.is_some()).count() as u8;
        t.segments_total = count as u32;
        t.segments_completed = 0;
        t.message = Some(format!("正在并发下载（{count} 路）"));
    });
    let mut sampled_at = Instant::now();
    let mut last_bytes = initial_bytes;
    let mut smoothed_speed = 0u64;
    loop {
        thread::sleep(Duration::from_millis(500));
        if cancel_requested(&store, &task.id) {
            stop_process(&store, &task.id);
            if pause_requested(&store, &task.id) {
                // Keep every delivered byte so resuming continues each part where it stopped.
                for transfer in &transfers {
                    let _ = absorb_continuation(transfer);
                }
            } else {
                // A cancelled download keeps its contiguous prefix as the partial output file.
                if let Some(first) = transfers.first() {
                    if absorb_continuation(first).is_ok()
                        && fs::metadata(&first.part).map(|m| m.len()).unwrap_or(0) > 0
                    {
                        let _ = fs::copy(&first.part, &output);
                    }
                }
                let _ = fs::remove_dir_all(&part_dir);
            }
            mark_stopped(&store, &writer, &task.id);
            return true;
        }
        let bytes: u64 = transfers.iter().map(part_bytes).sum();
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
        let statuses: Vec<Option<bool>> = transfers
            .iter()
            .map(|transfer| match &transfer.child {
                None => Some(true),
                Some(child) => child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok().flatten())
                    .map(|status| status.success()),
            })
            .collect();
        let completed = statuses.iter().filter(|status| **status == Some(true)).count() as u32;
        update(&store, &writer, &task.id, |t| {
            t.progress = ((bytes.saturating_mul(100) / total).min(99)) as u8;
            t.downloaded_bytes = bytes;
            t.speed_bytes_per_second = smoothed_speed;
            t.eta_seconds =
                (smoothed_speed > 0).then(|| total.saturating_sub(bytes) / smoothed_speed);
            t.segments_completed = completed;
        });
        if statuses.iter().all(Option::is_some) {
            for child in transfers.iter().filter_map(|transfer| transfer.child.as_ref()) {
                unregister_process(&store, &task.id, child);
            }
            let valid = statuses.iter().all(|status| *status == Some(true))
                && transfers.iter().all(|transfer| {
                    absorb_continuation(transfer).is_ok()
                        && fs::metadata(&transfer.part).map(|m| m.len()).unwrap_or(0)
                            == transfer.length
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
            for transfer in &transfers {
                let mut part = match fs::File::open(&transfer.part) {
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

pub(crate) fn start_http_download(store: TaskRuntime, writer: Writer, task: Task, output: String) {
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
    // Parts left by an earlier paused run cannot be continued by a single connection.
    let _ = fs::remove_dir_all(parallel_part_dir(&output, &task.id));
    start_single_http_download(store, writer, task, output, probe.total);
}
