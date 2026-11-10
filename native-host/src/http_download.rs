use crate::model::Task;
use crate::processes::cancel_requested;
use crate::processes::pause_requested;
use crate::processes::mark_stopped;
use crate::processes::spawn_process;
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
use std::io::Write;
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

pub(crate) fn curl_base_args() -> Vec<String> {
    [
        "--disable",
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
        "--max-redirs",
        "20",
        // The bundled curl-for-win build uses LibreSSL; this makes it verify
        // against the Windows certificate store so no cacert file ships with it.
        "--ca-native",
        "--proxy-ca-native",
        "--config",
        "-",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn add_header_args(args: &mut Vec<String>, task: &Task, url: &str) {
    let same_origin = !task.hls_selection
        || url::Url::parse(&task.url).ok().zip(url::Url::parse(url).ok())
            .is_some_and(|(source, target)| source.origin() == target.origin());
    for (name, value) in &task.request_headers {
        if !same_origin && crate::repository::is_sensitive_request_header(name) {
            continue;
        }
        args.push("--header".into());
        args.push(format!("{name}: {value}"));
    }
}

pub(crate) fn add_request_args(args: &mut Vec<String>, task: &Task, url: &str) {
    crate::network::add_proxy_args(args, &task.network, url);
    add_header_args(args, task, url);
}

fn curl_config_text(options: &[String]) -> io::Result<String> {
    let mut text = String::new();
    let mut pairs = options.chunks_exact(2);
    for pair in &mut pairs {
        if !matches!(pair[0].as_str(), "--url" | "--header" | "--proxy" | "--noproxy") {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "curl_config_invalid_option"));
        }
        text.push_str(pair[0].trim_start_matches('-'));
        text.push_str(" = \"");
        for character in pair[1].chars() {
            match character {
                '\\' => text.push_str("\\\\"),
                '"' => text.push_str("\\\""),
                '\t' => text.push_str("\\t"),
                '\n' => text.push_str("\\n"),
                '\r' => text.push_str("\\r"),
                '\u{000b}' => text.push_str("\\v"),
                value if value.is_control() => {
                    return Err(io::Error::new(io::ErrorKind::InvalidInput, "curl_config_control_character"));
                }
                value => text.push(value),
            }
        }
        text.push_str("\"\n");
    }
    if !pairs.remainder().is_empty() {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "curl_config_missing_value"));
    }
    Ok(text)
}

pub(crate) fn spawn_curl(
    store: &TaskRuntime,
    task: &Task,
    url: &str,
    command: &mut Command,
) -> io::Result<Arc<Mutex<Child>>> {
    let mut request = Vec::new();
    add_request_args(&mut request, task, url);
    request.extend(["--url".into(), url.into()]);
    let config = curl_config_text(&request)?;
    let child = spawn_process(store, &task.id, command.stdin(Stdio::piped()))?;
    let configured = (|| -> io::Result<()> {
        // Release the process lock before writing so shutdown can kill a blocked child.
        let mut stdin = child.lock().map_err(|_| io::Error::other("process_lock_poisoned"))?
            .stdin.take().ok_or_else(|| io::Error::other("curl_stdin_missing"))?;
        let result = stdin.write_all(config.as_bytes());
        drop(stdin);
        result
    })();
    if let Err(error) = configured {
        {
            let mut process = child.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let _ = process.kill();
            let _ = process.wait();
        }
        unregister_process(store, &task.id, &child);
        return Err(io::Error::new(error.kind(), "curl_config_write_failed"));
    }
    Ok(child)
}

pub(crate) fn probe_size_args() -> Vec<String> {
    let mut args = curl_base_args();
    args.extend([
        "--silent".to_string(),
        "--show-error".to_string(),
        "--fail".to_string(),
        "--location".to_string(),
        "--connect-timeout".to_string(),
        "10".to_string(),
        "--max-time".to_string(),
        "20".to_string(),
        "--head".to_string(),
    ]);
    args
}

pub(crate) fn probe_size(store: &TaskRuntime, task: &Task) -> io::Result<ProbeInfo> {
    let mut command = match crate::media_process::curl_command() {
        Ok(command) => command,
        Err(_) => return Ok(ProbeInfo::default()),
    };
    command
        .args(probe_size_args())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let child = spawn_curl(store, task, &task.url, &mut command)?;
    loop {
        if cancel_requested(store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            unregister_process(store, &task.id, &child);
            return Ok(ProbeInfo {
                cancelled: true,
                ..ProbeInfo::default()
            });
        }
        let finished = match child.lock() {
            Ok(mut child) => match child.try_wait() {
                Ok(status) => status,
                Err(_) => return Ok(ProbeInfo::default()),
            },
            Err(_) => return Ok(ProbeInfo::default()),
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
                return Ok(ProbeInfo::default());
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
            return Ok(ProbeInfo {
                total,
                accept_ranges,
                cancelled: false,
            });
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(crate) fn single_download_args(output: &std::path::Path) -> Vec<String> {
    let mut args = curl_base_args();
    args.extend([
        "--silent".to_string(),
        "--show-error".to_string(),
        "--fail".to_string(),
        "--location".to_string(),
        "--retry".to_string(),
        "3".to_string(),
        "--retry-all-errors".to_string(),
        "--speed-limit".to_string(),
        "1".to_string(),
        "--speed-time".to_string(),
        "60".to_string(),
        "--continue-at".to_string(),
        "-".to_string(),
        "--output".to_string(),
        output.file_name().unwrap_or_default().to_string_lossy().into_owned(),
    ]);
    args
}

pub(crate) fn single_temporary_path(output: &std::path::Path, task_id: &str) -> PathBuf {
    let id: String = task_id.as_bytes().iter().map(|byte| format!("{byte:02x}")).collect();
    output.with_file_name(format!(".streamfirefly-{id}.download"))
}

fn prepare_single_output(output: &std::path::Path, temporary: &std::path::Path) -> io::Result<()> {
    if !temporary.exists() && output.exists() {
        crate::persistence::move_new_file(output, temporary)?;
    }
    Ok(())
}

fn finish_single_output(output: &std::path::Path, temporary: &std::path::Path) -> io::Result<()> {
    if temporary.exists() {
        crate::persistence::move_new_file(temporary, output)
    } else {
        Ok(())
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
    let output_path = PathBuf::from(&output);
    let temporary = single_temporary_path(&output_path, &task.id);
    let mut command = match crate::media_process::curl_command() {
        Ok(command) => command,
        Err(error) => {
            update(&store, &writer, &task.id, |t| {
                t.state = "failed".into();
                t.phase = "failed".into();
                t.error = Some(error.to_string());
                t.message = Some("下载程序缺失，请重新安装 StreamFirefly".into());
            });
            return;
        }
    };
    if let Err(error) = prepare_single_output(&output_path, &temporary) {
        update(&store, &writer, &task.id, |t| {
            t.state = "failed".into();
            t.phase = "failed".into();
            t.error = Some(error.to_string());
            t.message = Some("无法准备下载文件".into());
        });
        return;
    }
    if let Some(parent) = output_path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        command.current_dir(parent);
    }
    let child = match spawn_curl(&store, &task, &task.url, command
        .args(single_download_args(&temporary))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
    ) {
        Ok(child) => child,
        Err(error) => {
            let _ = finish_single_output(&output_path, &temporary);
            if cancel_requested(&store, &task.id) {
                mark_stopped(&store, &writer, &task.id);
                return;
            }
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
    let mut last_bytes = fs::metadata(&temporary).map(|m| m.len()).unwrap_or(0);
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
            let _ = finish_single_output(&output_path, &temporary);
            mark_stopped(&store, &writer, &task.id);
            return;
        }
        let bytes = fs::metadata(&temporary).map(|m| m.len()).unwrap_or(last_bytes);
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
                let published = finish_single_output(&output_path, &temporary);
                if cancel_requested(&store, &task.id) {
                    mark_stopped(&store, &writer, &task.id);
                    return;
                }
                if status.success() && published.is_ok() && output_path.is_file() {
                    update(&store, &writer, &task.id, |t| {
                        t.state = "succeeded".into();
                        t.phase = "completed".into();
                        t.progress = 100;
                        t.downloaded_bytes = fs::metadata(&output_path).map(|m| m.len()).unwrap_or(bytes);
                        t.total_bytes = total.or(Some(t.downloaded_bytes));
                        t.active_connections = 0;
                        t.eta_seconds = Some(0);
                        t.message = Some("下载完成".into());
                    });
                } else {
                    let conflict = published.as_ref().err()
                        .is_some_and(|error| error.kind() == io::ErrorKind::AlreadyExists);
                    update(&store, &writer, &task.id, |t| {
                        t.state = "failed".into();
                        t.phase = "failed".into();
                        t.active_connections = 0;
                        t.error = Some(if conflict { "output_path_conflict" } else if status.success() { "output_publish_failed" } else { "curl_download_failed" }.into());
                        t.message = Some(if conflict {
                            "输出文件已存在或被其他任务占用，请保留原文件并新建任务。"
                        } else {
                            "下载失败，请检查网络或资源地址"
                        }.into());
                    });
                }
                break;
            }
            Err(error) => {
                unregister_process(&store, &task.id, &child);
                let _ = finish_single_output(&output_path, &temporary);
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

fn finish_failed_parallel_download(
    store: &TaskRuntime,
    task_id: &str,
    part_dir: &std::path::Path,
    transfers: &[PartTransfer],
) -> bool {
    stop_process(store, task_id);
    if crate::runtime::host_exiting(store) {
        for transfer in transfers {
            let _ = absorb_continuation(transfer);
        }
        // Shutdown is handled: keep the layout and prefixes, and never fall back to a single transfer.
        true
    } else {
        let _ = fs::remove_dir_all(part_dir);
        false
    }
}

fn parallel_part_args(
    start: u64,
    end: u64,
    existing: u64,
    continuation: &std::path::Path,
) -> Vec<String> {
    let mut args = curl_base_args();
    args.extend([
        "--silent".to_string(),
        "--show-error".to_string(),
        "--fail".to_string(),
        "--location".to_string(),
        "--retry".to_string(),
        "3".to_string(),
        "--retry-all-errors".to_string(),
        "--speed-limit".to_string(),
        "1".to_string(),
        "--speed-time".to_string(),
        "60".to_string(),
        "--range".to_string(),
        format!("{}-{end}", start + existing),
        "--output".to_string(),
        continuation.file_name().unwrap_or_default().to_string_lossy().into_owned(),
    ]);
    args
}

pub(crate) fn start_parallel_http_download(
    store: TaskRuntime,
    writer: Writer,
    task: Task,
    output: String,
    total: u64,
) -> bool {
    if crate::runtime::host_exiting(&store) {
        return true;
    }
    let count = usize::from(task.download_threads.clamp(2, MAX_DOWNLOAD_THREADS));
    let part_dir = parallel_part_dir(&output, &task.id);
    // Parts from a paused run are reused only when they were split for the same size and connection count.
    let layout_file = part_dir.join("layout");
    let layout = format!("{total}:{count}");
    if fs::read_to_string(&layout_file).ok().as_deref() != Some(layout.as_str()) {
        let _ = fs::remove_dir_all(&part_dir);
        if fs::create_dir_all(&part_dir).is_err() || fs::write(&layout_file, &layout).is_err() {
            return finish_failed_parallel_download(&store, &task.id, &part_dir, &[]);
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
            match crate::media_process::curl_command() {
                Ok(mut command) => match spawn_curl(&store, &task, &task.url, command
                    .current_dir(&part_dir)
                    .args(parallel_part_args(
                        *start,
                        *end,
                        existing,
                        &transfer.continuation,
                    ))
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                )
                {
                    Ok(child) => transfer.child = Some(child),
                    Err(_) => {
                        transfers.push(transfer);
                        return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
                    }
                },
                Err(_) => {
                    transfers.push(transfer);
                    return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
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
        if crate::runtime::host_exiting(&store) {
            return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
        }
        if cancel_requested(&store, &task.id) {
            stop_process(&store, &task.id);
            if pause_requested(&store, &task.id) || crate::runtime::host_exiting(&store) {
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
        // A lock failure or try_wait error means the process can no longer be tracked; fail
        // instead of looping forever with a task slot held.
        let mut monitor_error = false;
        let statuses: Vec<Option<bool>> = transfers
            .iter()
            .map(|transfer| match &transfer.child {
                None => Some(true),
                Some(child) => {
                    let mut process = match child.lock() {
                        Ok(process) => process,
                        Err(_) => {
                            monitor_error = true;
                            return None;
                        }
                    };
                    match process.try_wait() {
                        Ok(Some(status)) => Some(status.success()),
                        Ok(None) => None,
                        Err(_) => {
                            monitor_error = true;
                            None
                        }
                    }
                }
            })
            .collect();
        if monitor_error {
            return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
        }
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
                return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
            }
            if crate::runtime::host_exiting(&store) {
                return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
            }
            let mut destination = match OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&output)
            {
                Ok(file) => file,
                Err(_) => {
                    return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
                }
            };
            for transfer in &transfers {
                let mut part = match fs::File::open(&transfer.part) {
                    Ok(file) => file,
                    Err(_) => {
                        return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
                    }
                };
                if io::copy(&mut part, &mut destination).is_err() {
                    return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
                }
            }
            if crate::runtime::host_exiting(&store) {
                return finish_failed_parallel_download(&store, &task.id, &part_dir, &transfers);
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
    if crate::runtime::host_exiting(&store) {
        return;
    }
    let probe = match probe {
        Ok(probe) => probe,
        Err(_) if cancel_requested(&store, &task.id) => {
            mark_stopped(&store, &writer, &task.id);
            return;
        }
        Err(error) => {
            update(&store, &writer, &task.id, |current| {
                current.state = "failed".into();
                current.phase = "failed".into();
                current.error = Some(error.to_string());
                current.message = Some("无法启动下载程序".into());
            });
            return;
        }
    };
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
    if crate::runtime::host_exiting(&store) {
        return;
    }
    // Parts left by an earlier paused run cannot be continued by a single connection.
    let _ = fs::remove_dir_all(parallel_part_dir(&output, &task.id));
    start_single_http_download(store, writer, task, output, probe.total);
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn test_task() -> Task {
        serde_json::from_value(serde_json::json!({
            "id": "task-1",
            "url": "http://127.0.0.1/media.mp4",
            "title": "media",
            "state": "queued",
            "progress": 0,
            "output": null,
            "error": null,
            "mime": "video/mp4"
        }))
        .unwrap()
    }

    #[test]
    fn curl_base_args_pinned() {
        assert_eq!(
            curl_base_args(),
            vec![
                "--disable",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--max-redirs",
                "20",
                "--ca-native",
                "--proxy-ca-native",
                "--config",
                "-"
            ]
        );
    }

    #[test]
    fn probe_size_args_start_with_proto_whitelist() {
        let args = probe_size_args();
        assert_eq!(args[0], "--disable");
        assert!(args.starts_with(&curl_base_args()));
        assert!(args.windows(2).any(|pair| pair == ["--max-time", "20"]));
        assert!(args.iter().any(|arg| arg == "--head"));
        assert_request_values_absent(&args);
    }

    #[test]
    fn single_download_args_start_with_proto_whitelist_and_stall_timeout() {
        let args = single_download_args(Path::new("中文目录/out.mp4"));
        assert_eq!(args[0], "--disable");
        assert!(args.starts_with(&curl_base_args()));
        assert!(args.windows(2).any(|pair| pair == ["--speed-limit", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-time", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["--output", "out.mp4"]));
        assert_request_values_absent(&args);
    }

    #[test]
    fn parallel_part_args_start_with_proto_whitelist_and_stall_timeout() {
        let args = parallel_part_args(100, 199, 40, Path::new("中文目录/part.next"));
        assert_eq!(args[0], "--disable");
        assert!(args.starts_with(&curl_base_args()));
        assert!(args.windows(2).any(|pair| pair == ["--speed-limit", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-time", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["--range", "140-199"]));
        assert!(args.windows(2).any(|pair| pair == ["--output", "part.next"]));
        assert_request_values_absent(&args);
    }

    fn assert_request_values_absent(args: &[String]) {
        assert!(args.windows(2).any(|pair| pair == ["--config", "-"]));
        assert!(args.iter().all(|arg| arg.is_ascii()));
        assert!(!args.iter().any(|arg| matches!(arg.as_str(), "--url" | "--header" | "--proxy" | "--noproxy")));
        assert!(!args.iter().any(|arg| arg.contains("http://") || arg.contains("https://")));
    }

    #[test]
    fn curl_config_preserves_utf8_and_escapes_quotes_backslashes_and_spaces() {
        let options = [
            "--url", "https://example.test/中文?q=\"a b\"&path=C:\\media",
            "--header", "user-agent: 中文 \"quoted\" C:\\media",
            "--proxy", "http://代理.test:7897", "--noproxy", "",
        ].map(str::to_string);
        assert_eq!(curl_config_text(&options).unwrap(), concat!(
            "url = \"https://example.test/中文?q=\\\"a b\\\"&path=C:\\\\media\"\n",
            "header = \"user-agent: 中文 \\\"quoted\\\" C:\\\\media\"\n",
            "proxy = \"http://代理.test:7897\"\n",
            "noproxy = \"\"\n",
        ));
    }

    #[test]
    fn curl_config_escapes_documented_controls_and_rejects_unrepresentable_values() {
        assert_eq!(curl_config_text(&["--header".into(), "x: \t\n\r\u{000b}\"\nurl = evil".into()]).unwrap(),
            "header = \"x: \\t\\n\\r\\v\\\"\\nurl = evil\"\n");
        for byte in (0u8..=31).chain([127]) {
            if [9, 10, 11, 13].contains(&byte) { continue; }
            let error = curl_config_text(&["--url".into(), format!("prefix{}suffix", char::from(byte))]).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
        assert!(curl_config_text(&["--url".into()]).is_err());
        assert!(curl_config_text(&["--url\nheader".into(), "value".into()]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn curl_stdin_is_closed_and_a_write_failure_is_reaped_and_unregistered() {
        use std::os::windows::process::CommandExt;
        let directory = std::env::temp_dir().join(format!("streamfirefly-curl-stdin-{}", uuid::Uuid::new_v4()));
        let store = crate::runtime::load_store(&directory.join("tasks.json"));
        let mut task = test_task();
        task.network = crate::network::NetworkConfig::from_payload(&serde_json::json!({"mode":"direct"})).unwrap();
        let mut reader = Command::new("powershell.exe");
        reader.args(["-NoProfile", "-Command", "$memory = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($memory); [Console]::Write($memory.Length)"])
            .creation_flags(0x08000000).stdout(Stdio::piped()).stderr(Stdio::null());
        let child = spawn_curl(&store, &task, &task.url, &mut reader).unwrap();
        assert!(child.lock().unwrap().stdin.is_none());
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut status = None;
        while Instant::now() < deadline {
            status = child.lock().unwrap().try_wait().unwrap();
            if status.is_some() { break; }
            thread::sleep(Duration::from_millis(20));
        }
        stop_process(&store, &task.id);
        unregister_process(&store, &task.id, &child);
        assert!(status.is_some_and(|status| status.success()), "Child did not receive stdin EOF");
        let mut received = String::new();
        child.lock().unwrap().stdout.take().unwrap().read_to_string(&mut received).unwrap();
        assert!(received.parse::<usize>().unwrap() > 0);

        task.request_headers.insert("user-agent".into(), "synthetic".repeat(256 * 1024));
        let mut closed = Command::new("powershell.exe");
        closed.args(["-NoProfile", "-Command", "exit 0"]).creation_flags(0x08000000);
        let result = spawn_curl(&store, &task, &task.url, &mut closed);
        assert_eq!(result.unwrap_err().to_string(), "curl_config_write_failed");
        assert!(store.processes.lock().unwrap().is_empty());
    }

    #[test]
    fn single_output_resumes_through_an_ascii_name_and_publishes_the_unicode_path() {
        let directory = std::env::temp_dir().join(format!("streamfirefly-single-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("代理链路.mp4");
        let temporary = single_temporary_path(&output, "任务-1");
        assert!(temporary.file_name().unwrap().to_string_lossy().is_ascii());
        fs::write(&output, b"prefix").unwrap();
        prepare_single_output(&output, &temporary).unwrap();
        assert!(!output.exists());
        let mut file = OpenOptions::new().append(true).open(&temporary).unwrap();
        std::io::Write::write_all(&mut file, b" suffix").unwrap();
        drop(file);
        finish_single_output(&output, &temporary).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"prefix suffix");
        assert!(!temporary.exists());
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn single_output_publication_preserves_both_files_on_conflict() {
        let directory = std::env::temp_dir().join(format!("streamfirefly-conflict-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("video.mp4");
        let temporary = single_temporary_path(&output, "task-1");
        fs::write(&output, b"other program").unwrap();
        fs::write(&temporary, b"download").unwrap();
        let result = finish_single_output(&output, &temporary);
        assert_eq!(fs::read(&output).unwrap(), b"other program");
        assert_eq!(fs::read(&temporary).unwrap(), b"download");
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn single_output_preparation_preserves_both_existing_files() {
        let directory = std::env::temp_dir().join(format!("streamfirefly-prepare-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("video.mp4");
        let temporary = single_temporary_path(&output, "task-1");
        fs::write(&output, b"other program").unwrap();
        fs::write(&temporary, b"prefix").unwrap();
        prepare_single_output(&output, &temporary).unwrap();
        assert_eq!(fs::read(&output).unwrap(), b"other program");
        assert_eq!(fs::read(&temporary).unwrap(), b"prefix");
        fs::remove_dir_all(&directory).unwrap();
    }
}
