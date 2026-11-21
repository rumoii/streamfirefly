use crate::model::Task;
use crate::processes::cancel_requested;
use crate::processes::spawn_process;
use crate::processes::unregister_process;
use crate::runtime::TaskRuntime;
use crate::task_state::update;
use crate::wire::Writer;
use std::fs;
use std::io::BufRead;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

/// FFmpeg makes no output and progress movement for this long is treated as stuck.
const STALL_LIMIT: Duration = Duration::from_secs(60);

/// Tools ship beside the native host executable and are only launched by absolute path,
/// so a stray curl.exe/ffmpeg.exe on PATH or in the working directory is never picked up.
pub(crate) fn bundled_tool(name: &str) -> Result<PathBuf, &'static str> {
    let file_name = PathBuf::from(name);
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .ok_or_else(|| match file_name.extension().and_then(|value| value.to_str()) {
            Some("exe") => match file_name.file_stem().and_then(|value| value.to_str()) {
                Some("curl") => "tool_missing:curl",
                Some("ffmpeg") => "tool_missing:ffmpeg",
                _ => "tool_missing",
            },
            _ => "tool_missing",
        })
}

pub(crate) fn ffmpeg_command() -> Result<Command, &'static str> {
    bundled_tool("ffmpeg.exe").map(Command::new)
}

pub(crate) fn curl_command() -> Result<Command, &'static str> {
    bundled_tool("curl.exe").map(Command::new)
}

pub(crate) fn set_output_state(
    task: &mut Task,
    kind: &str,
    index: usize,
    state: &str,
    error: Option<String>,
) {
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

pub(crate) fn run_ffmpeg_with_progress(
    store: &TaskRuntime,
    writer: &Writer,
    task: &Task,
    args: Vec<String>,
    progress_path: &std::path::Path,
    duration: f64,
    progress_start: u8,
    progress_span: u8,
    message: &str,
) -> Result<(), String> {
    let mut command = ffmpeg_command().map_err(|error| error.to_string())?;
    let child = spawn_process(store, &task.id, command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
    )
        .map_err(|error| error.to_string())?;
    let stdout = child
        .lock().map_err(|_| "process_lock_poisoned")?
        .stdout
        .take()
        .ok_or_else(|| "ffmpeg_progress_unavailable".to_string())?;
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
    let mut stall_bytes = 0;
    let mut stall_position = -1.0_f64;
    let mut stalled_since: Option<Instant> = None;
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
        let bytes = fs::metadata(progress_path)
            .map(|metadata| metadata.len())
            .unwrap_or(last_bytes);
        let speed = (bytes.saturating_sub(last_bytes) as f64
            / sampled_at.elapsed().as_secs_f64().max(0.001)) as u64;
        last_bytes = bytes;
        sampled_at = Instant::now();
        let seconds = position.lock().map(|value| *value).unwrap_or(0.0);
        // Like capture_merge: no output growth and no progress movement for this long means stuck.
        if bytes != stall_bytes || seconds != stall_position {
            stall_bytes = bytes;
            stall_position = seconds;
            stalled_since = None;
        } else if stalled_since.is_none() {
            stalled_since = Some(Instant::now());
        }
        if stalled_since.is_some_and(|since| since.elapsed() >= STALL_LIMIT) {
            if let Ok(mut process) = child.lock() {
                let _ = process.kill();
                let _ = process.wait();
            }
            unregister_process(store, &task.id, &child);
            return Err("ffmpeg_stalled".into());
        }
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
        let waited = child
            .lock()
            .map_err(|_| "process_lock_poisoned".to_string())
            .and_then(|mut process| process.try_wait().map_err(|error| error.to_string()));
        match waited {
            Ok(Some(status)) => {
                unregister_process(store, &task.id, &child);
                return if status.success() {
                    Ok(())
                } else {
                    Err("ffmpeg_unavailable_or_failed".into())
                };
            }
            Ok(None) => {}
            Err(error) => {
                if let Ok(mut process) = child.lock() {
                    let _ = process.kill();
                    let _ = process.wait();
                }
                unregister_process(store, &task.id, &child);
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TOOL_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn curl_command_uses_the_absolute_bundled_path() {
        let _guard = TOOL_TEST_LOCK.lock().unwrap();
        let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        let bundled = dir.join("curl.exe");
        let created = !bundled.is_file();
        if created {
            fs::write(&bundled, b"test fixture").unwrap();
        }
        let command = curl_command();
        if created {
            fs::remove_file(&bundled).unwrap();
        }
        let command = command.unwrap();
        assert_eq!(command.get_program(), bundled.as_os_str());
        assert!(PathBuf::from(command.get_program()).is_absolute());
    }

    #[test]
    fn bundled_tool_without_file_returns_error_not_bare_name() {
        let missing = "definitely-not-a-streamfirefly-tool-xyz.exe";
        assert!(!std::env::current_exe()
            .unwrap()
            .parent()
            .map(|dir| dir.join(missing))
            .is_some_and(|path| path.is_file()));
        assert_eq!(bundled_tool(missing), Err("tool_missing"));
    }

    #[test]
    fn bundled_tool_reports_named_missing_tools() {
        let _guard = TOOL_TEST_LOCK.lock().unwrap();
        let dir = std::env::current_exe().unwrap().parent().unwrap().to_path_buf();
        assert!(!dir.join("curl.exe").is_file());
        assert!(!dir.join("ffmpeg.exe").is_file());
        assert_eq!(bundled_tool("curl.exe"), Err("tool_missing:curl"));
        assert_eq!(bundled_tool("ffmpeg.exe"), Err("tool_missing:ffmpeg"));
    }
}
