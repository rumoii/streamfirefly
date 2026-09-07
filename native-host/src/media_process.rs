use crate::model::Task;
use crate::processes::cancel_requested;
use crate::processes::register_process;
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

pub(crate) fn bundled_tool(name: &str) -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(|parent| parent.join(name)))
        .filter(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from(name))
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
