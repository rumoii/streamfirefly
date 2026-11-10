use crate::http_download::curl_base_args;
use crate::http_download::spawn_curl;
use crate::model::Task;
use crate::processes::{cancel_requested, unregister_process};
use crate::runtime::TaskRuntime;
use crate::segments::ByteRange;
use std::{
    fs,
    io::Read,
    path::Path,
    process::Stdio,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};

static NEXT_TEMPORARY_FILE: AtomicU64 = AtomicU64::new(0);

fn ascii_temporary_path(destination: &Path, extension: &str) -> std::path::PathBuf {
    let sequence = NEXT_TEMPORARY_FILE.fetch_add(1, Ordering::Relaxed);
    destination.with_file_name(format!(".streamfirefly-{}-{sequence}.{extension}", std::process::id()))
}

pub(crate) fn curl_once_args(
    range: Option<&ByteRange>,
    temporary: &Path,
    response_headers: &Path,
) -> Vec<String> {
    let mut args = curl_base_args();
    args.extend([
        "--silent".to_string(),
        "--show-error".to_string(),
        "--location".to_string(),
        "--connect-timeout".to_string(),
        "10".to_string(),
        "--max-time".to_string(),
        "120".to_string(),
        "--speed-limit".to_string(),
        "1".to_string(),
        "--speed-time".to_string(),
        "60".to_string(),
        "--output".to_string(),
        temporary.file_name().unwrap_or_default().to_string_lossy().into_owned(),
    ]);
    args.extend([
        "--dump-header".to_string(),
        response_headers.file_name().unwrap_or_default().to_string_lossy().into_owned(),
    ]);
    args.extend(["--write-out".to_string(), "%{http_code}".to_string()]);
    if let Some(range) = range {
        args.extend([
            "--range".to_string(),
            format!("{}-{}", range.start, range.start + range.length - 1),
        ]);
    }
    args
}

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
    let temporary = ascii_temporary_path(destination, "download");
    let response_headers = ascii_temporary_path(destination, "headers");
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&response_headers);
    let mut command = crate::media_process::curl_command()?;
    if let Some(parent) = destination.parent().filter(|parent| !parent.as_os_str().is_empty()) {
        command.current_dir(parent);
    }
    let child = spawn_curl(store, task, url, command
        .args(curl_once_args(range, &temporary, &response_headers))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
    )
        .map_err(|error| error.to_string())?;
    let mut stdout = child.lock().map_err(|_| "process_lock_poisoned")?.stdout.take();
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
        if abort.load(Ordering::Relaxed)
            || cancel_requested(store, task_id)
            || crate::runtime::host_exiting(store)
        {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    true
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::http_download::curl_base_args;

    #[test]
    fn curl_once_args_start_with_proto_whitelist_and_stall_timeout() {
        let args = curl_once_args(
            Some(&ByteRange { start: 100, length: 100 }),
            Path::new("中文目录/seg.download"),
            Path::new("中文目录/seg.headers"),
        );
        assert_eq!(args[0], "--disable");
        assert!(args.starts_with(&curl_base_args()));
        assert!(args.windows(2).any(|pair| pair == ["--max-time", "120"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-limit", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["--speed-time", "60"]));
        assert!(args.windows(2).any(|pair| pair == ["--range", "100-199"]));
        assert!(args.windows(2).any(|pair| pair == ["--config", "-"]));
        assert!(args.iter().all(|arg| arg.is_ascii()));
        assert!(!args.iter().any(|arg| matches!(arg.as_str(), "--url" | "--header" | "--proxy" | "--noproxy")));
        assert!(!args.iter().any(|arg| arg.contains("http://") || arg.contains("https://")));
        let headless = curl_once_args(
            None,
            Path::new("中文目录/seg.download"),
            Path::new("中文目录/seg.headers"),
        );
        assert!(!headless.windows(2).any(|pair| pair[0] == "--range"));
    }
}
