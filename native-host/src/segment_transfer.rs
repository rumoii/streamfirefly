use crate::http_download::add_request_args;
use crate::model::Task;
use crate::processes::{cancel_requested, register_process, unregister_process};
use crate::runtime::TaskRuntime;
use crate::segments::ByteRange;
use std::{
    fs,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub(crate) fn curl_once(
    store: &TaskRuntime,
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
        "--proto",
        "=http,https",
        "--proto-redir",
        "=http,https",
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
    add_request_args(&mut args, task, url);
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
                let headers = fs::read_to_string(&response_headers).unwrap_or_default();
                let content_range = headers.lines().rev().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-range")
                        .then(|| value.trim())
                });
                let expected = format!("bytes {}-{}/", range.start, range.start + range.length - 1);
                if bytes != range.length
                    || http_status != 206
                    || !content_range.is_some_and(|value| value.starts_with(&expected))
                {
                    let _ = fs::remove_file(&temporary);
                    let _ = fs::remove_file(&response_headers);
                    return Err("byte_range_mismatch".into());
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

pub(crate) fn retryable_error(error: &str) -> bool {
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
            "byte_range_mismatch" | "connection_reset" | "operation_timed_out" | "curl_failed"
        ),
    }
}

pub(crate) fn authorization_error(error: &str) -> bool {
    error.starts_with("http_status_401") || error.starts_with("http_status_403")
}

pub(crate) fn retry_after_seconds(error: &str) -> Option<u64> {
    error
        .split(":retry_after=")
        .nth(1)
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.min(30))
}

pub(crate) fn wait_retry(
    store: &TaskRuntime,
    task_id: &str,
    abort: &AtomicBool,
    seconds: u64,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        if abort.load(Ordering::Relaxed) || cancel_requested(store, task_id) {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}
