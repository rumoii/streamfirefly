use crate::capture_diagnostics::{drain_stderr, record};
use crate::capture_export::export;
use crate::capture_model::{Session, Track};
use crate::capture_storage::save;
use crate::capture_format::inspect_file;
use crate::capture_output::{matches, read_progress};
use crate::media_process::bundled_tool;
use crate::persistence::replace_file;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
pub(crate) fn finalize(session: &Arc<Mutex<Session>>) {
    let (directory, tracks) = {
        let current = session.lock().unwrap();
        record(
            &current,
            "finalization-started",
            json!({"state":current.snapshot.state,"bytes":current.snapshot.bytes}),
        );
        (current.directory.clone(), current.snapshot.tracks.clone())
    };
    let mut generations: BTreeMap<u32, Vec<Track>> = BTreeMap::new();
    for track in tracks {
        generations.entry(track.generation).or_default().push(track);
    }
    let mut outputs = Vec::new();
    let mut complete = !generations.is_empty();
    let mut failure = "capture_no_media_data";
    for (generation, tracks) in &generations {
        let inspections: Vec<_> = tracks.iter().map(|track| inspect_file(&directory.join(&track.file), &track.mime)).collect();
        if tracks.iter().all(|track| track.bytes == 0) || inspections.iter().all(|inspection| inspection.as_ref().is_ok_and(|value| value.initialized && !value.media)) { continue; }
        {
            let mut current = session.lock().unwrap();
            for (track, inspection) in tracks.iter().zip(&inspections) {
                if let Some(saved) = current.snapshot.tracks.iter_mut().find(|saved| saved.id == track.id) {
                    saved.initialized = inspection.as_ref().is_ok_and(|value| value.initialized);
                }
            }
        }
        let initialized = tracks.iter().zip(&inspections).all(|(track, inspection)| inspection.as_ref().is_ok_and(|value| value.initialized)
            && fs::metadata(directory.join(&track.file)).is_ok_and(|metadata| metadata.len() == track.bytes));
        if !initialized {
            complete = false;
            if failure != "capture_merge_failed" { failure = "capture_initialization_missing"; }
            continue;
        }
        let output = directory.join(format!("capture-{generation}.mkv"));
        let temporary = directory.join(format!("capture-{generation}.pending.mkv"));
        let active: Vec<_> = tracks.iter().zip(&inspections).filter(|(_, inspection)| inspection.as_ref().is_ok_and(|value| value.media)).map(|(track, _)| track.clone()).collect();
        let merged = merge(&directory, &active, &temporary, session);
        let replaced = if merged {
            Some(replace_file(&temporary, &output))
        } else {
            None
        };
        record(
            &session.lock().unwrap(),
            "output-replacement",
            json!({"generation":generation,"attempted":merged,"error":replaced.as_ref().and_then(|result| result.as_ref().err()).map(ToString::to_string)}),
        );
        if replaced.is_some_and(|result| result.is_ok()) {
            outputs.push(output.to_string_lossy().into_owned());
        } else {
            complete = false;
            failure = "capture_merge_failed";
        }
    }
    let mut current = session.lock().unwrap();
    if current.snapshot.state == "interrupted" {
        return;
    }
    complete &= !outputs.is_empty() && current.snapshot.error.is_none();
    current.snapshot.state = if complete { "complete" } else { "partial" }.into();
    // Partial outputs stay in the session directory so that regenerating can replace them.
    if complete {
        outputs = export(&current, outputs);
    }
    current.snapshot.output = outputs.first().cloned();
    current.snapshot.outputs = outputs;
    // Without any output the merge failure matters more than an earlier interruption, which diagnostics keep.
    if !complete && (current.snapshot.error.is_none() || current.snapshot.outputs.is_empty()) {
        current.snapshot.error = Some(failure.into());
    }
    if save(&current).is_err() {
        current.snapshot.state = "partial".into();
        current.snapshot.error = Some("capture_checkpoint_failed".into());
        record(
            &current,
            "final-state-save-failed",
            json!({"state":current.snapshot.state}),
        );
    } else {
        record(
            &current,
            "final-state-saved",
            json!({"state":current.snapshot.state,"error":current.snapshot.error}),
        );
    }
}

fn merge(directory: &Path, tracks: &[Track], output: &Path, session: &Arc<Mutex<Session>>) -> bool {
    let mut command = Command::new(bundled_tool("ffmpeg.exe"));
    command.args(["-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"]);
    for track in tracks {
        command.arg("-i").arg(directory.join(&track.file));
    }
    for index in 0..tracks.len() {
        command.args(["-map", &format!("{index}:0")]);
    }
    command
        .args(["-c", "copy"])
        .arg(output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            record(
                &session.lock().unwrap(),
                "merge-start-failed",
                json!({"error":error.to_string()}),
            );
            return false;
        }
    };
    let started = Instant::now();
    let stdout = child.stdout.take().unwrap();
    let progress = match thread::Builder::new().name("capture-merge-progress".into()).spawn(move || read_progress(stdout)) {
        Ok(reader) => reader,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); record(&session.lock().unwrap(), "progress-reader-start-failed", json!({"error":error.to_string()})); return false; }
    };
    record(
        &session.lock().unwrap(),
        "merge-started",
        json!({"pid":child.id(),"generation":tracks[0].generation,"timeoutMs":120000}),
    );
    let stderr = child.stderr.take().unwrap();
    let stderr_path = directory.join(format!("ffmpeg-stderr-{}.txt", tracks[0].generation));
    let reader = match thread::Builder::new()
        .name("capture-merge-stderr".into())
        .spawn(move || drain_stderr(stderr, &stderr_path))
    {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            let _ = progress.join();
            record(
                &session.lock().unwrap(),
                "stderr-reader-start-failed",
                json!({"error":error.to_string()}),
            );
            return false;
        }
    };
    let deadline = Instant::now() + Duration::from_secs(120);
    let success = loop {
        if session
            .lock()
            .map_or(true, |current| current.snapshot.state == "interrupted")
        {
            let _ = child.kill();
            let _ = child.wait();
            record(
                &session.lock().unwrap(),
                "merge-interrupted",
                json!({"elapsedMs":started.elapsed().as_millis()}),
            );
            break false;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                record(
                    &session.lock().unwrap(),
                    "merge-exited",
                    json!({"exitCode":status.code(),"success":status.success(),"elapsedMs":started.elapsed().as_millis()}),
                );
                break status.success();
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                record(
                    &session.lock().unwrap(),
                    "merge-wait-failed",
                    json!({"error":error.to_string()}),
                );
                break false;
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                record(
                    &session.lock().unwrap(),
                    "merge-timeout",
                    json!({"elapsedMs":started.elapsed().as_millis()}),
                );
                break false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
        }
    };
    match reader.join() {
        Ok(Ok(())) => {}
        outcome => {
            record(
                &session.lock().unwrap(),
                "stderr-read-failed",
                json!({"error":format!("{outcome:?}")}),
            );
            eprintln!("capture merge stderr collection failed");
        }
    }
    let out_time_us = progress.join().ok().and_then(Result::ok).unwrap_or(0);
    let expected: Vec<_> = tracks.iter().map(|track| if track.mime.starts_with("video/") { 1 } else { 2 }).collect();
    let container_valid = matches(output, &expected);
    record(&session.lock().unwrap(), "output-validation", json!({"exitSuccess":success,"outTimeUs":out_time_us,"containerValid":container_valid,"expectedStreams":expected.len()}));
    success && out_time_us > 0 && container_valid
}
