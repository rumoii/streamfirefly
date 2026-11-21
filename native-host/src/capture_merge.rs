use crate::capture_diagnostics::{drain_stderr, record};
use crate::capture_export::export;
use crate::capture_model::{MergeProgress, Session, Track};
use crate::capture_storage::save;
use crate::capture_format::inspect_file;
use crate::capture_output::{matches, read_progress};
use crate::capture_space::{free_bytes, shortfall};
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
use crate::lock::LockExt;
/// Room kept beside the merged copy for container overhead and the rest of the system.
const SPACE_MARGIN: u64 = 256 * 1024 * 1024;
/// A merge that makes no progress for this long is treated as stuck.
const STALL_LIMIT: Duration = Duration::from_secs(60);

/// Remuxing copies every byte once, so the limit grows with the segment at a slow-disk 10 MiB/s.
fn merge_ceiling(bytes: u64) -> Duration {
    Duration::from_secs(120 + bytes / (10 * 1024 * 1024))
}

fn stalled(idle: Duration) -> bool {
    idle >= STALL_LIMIT
}

/// Failures reported by finalization itself. Regenerating starts without them, while an
/// interruption recorded during capture still marks the result as incomplete.
const FINALIZATION_ERRORS: [&str; 6] = ["capture_no_media_data", "capture_initialization_missing", "capture_disk_insufficient", "capture_merge_failed", "capture_merge_stalled", "capture_merge_timeout"];

pub(crate) fn clear_finalization_error(error: &mut Option<String>) {
    if error.as_deref().is_some_and(|code| FINALIZATION_ERRORS.contains(&code)) {
        *error = None;
    }
}

pub(crate) fn finalize(session: &Arc<Mutex<Session>>) {
    let (directory, tracks) = {
        let current = session.lock_or_recover();
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
    // Segments without media are skipped up front so the user sees "1/1" rather than "2/2" for one real segment.
    let segments: Vec<_> = generations
        .into_iter()
        .map(|(generation, tracks)| {
            let inspections: Vec<_> = tracks.iter().map(|track| inspect_file(&directory.join(&track.file), &track.mime)).collect();
            (generation, tracks, inspections)
        })
        .filter(|(_, tracks, inspections)| !(tracks.iter().all(|track| track.bytes == 0) || inspections.iter().all(|inspection| inspection.as_ref().is_ok_and(|value| value.initialized && !value.media))))
        .collect();
    let count = segments.len();
    for (index, (generation, tracks, inspections)) in segments.iter().enumerate() {
        // A host shutdown marks the session interrupted; never start another merge round then.
        if session
            .lock()
            .map_or(true, |current| current.snapshot.state == "interrupted")
        {
            return;
        }
        {
            let mut current = session.lock_or_recover();
            for (track, inspection) in tracks.iter().zip(inspections) {
                if let Some(saved) = current.snapshot.tracks.iter_mut().find(|saved| saved.id == track.id) {
                    saved.initialized = inspection.as_ref().is_ok_and(|value| value.initialized);
                }
            }
        }
        let initialized = tracks.iter().zip(inspections).all(|(track, inspection)| inspection.as_ref().is_ok_and(|value| value.initialized)
            && fs::metadata(directory.join(&track.file)).is_ok_and(|metadata| metadata.len() == track.bytes));
        if !initialized {
            complete = false;
            if failure == "capture_no_media_data" { failure = "capture_initialization_missing"; }
            continue;
        }
        let output = directory.join(format!("capture-{generation}.mkv"));
        let temporary = directory.join(format!("capture-{generation}.pending.mkv"));
        let active: Vec<_> = tracks.iter().zip(inspections).filter(|(_, inspection)| inspection.as_ref().is_ok_and(|value| value.media)).map(|(track, _)| track.clone()).collect();
        let total: u64 = active.iter().map(|track| track.bytes).sum();
        // The merged copy is written next to the raw tracks; exporting it later is a rename on the same volume.
        let free = free_bytes(&directory);
        {
            let mut current = session.lock_or_recover();
            current.runtime.free_bytes = free;
            if let Some(missing) = shortfall(total + SPACE_MARGIN, free) {
                record(&current, "merge-disk-insufficient", json!({"generation":generation,"neededBytes":total + SPACE_MARGIN,"freeBytes":free,"missingBytes":missing}));
                complete = false;
                failure = "capture_disk_insufficient";
                continue;
            }
            if free.is_none() {
                record(&current, "free-space-unknown", json!({"generation":generation}));
            }
            current.runtime.merge = Some(MergeProgress { segment: index + 1, segments: count, processed_bytes: 0, total_bytes: total, idle_seconds: 0 });
        }
        let merged = merge(&directory, &active, &temporary, session);
        session.lock_or_recover().runtime.merge = None;
        let replaced = if merged.is_ok() {
            Some(replace_file(&temporary, &output))
        } else {
            None
        };
        record(
            &session.lock_or_recover(),
            "output-replacement",
            json!({"generation":generation,"attempted":merged.is_ok(),"error":replaced.as_ref().and_then(|result| result.as_ref().err()).map(ToString::to_string)}),
        );
        if replaced.is_some_and(|result| result.is_ok()) {
            outputs.push(output.to_string_lossy().into_owned());
        } else {
            complete = false;
            // Missing disk space is the one cause the user can fix right away, so it stays in front.
            if failure != "capture_disk_insufficient" {
                failure = merged.err().unwrap_or("capture_merge_failed");
            }
        }
    }
    let mut current = session.lock_or_recover();
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

fn merge(directory: &Path, tracks: &[Track], output: &Path, session: &Arc<Mutex<Session>>) -> Result<(), &'static str> {
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
                &session.lock_or_recover(),
                "merge-start-failed",
                json!({"error":error.to_string()}),
            );
            return Err("capture_merge_failed");
        }
    };
    let started = Instant::now();
    let ceiling = merge_ceiling(tracks.iter().map(|track| track.bytes).sum());
    // Bytes written so far and when FFmpeg last moved forward.
    let advance = Arc::new(Mutex::new((0u64, started)));
    let reported = advance.clone();
    let stdout = child.stdout.take().unwrap();
    let progress = match thread::Builder::new().name("capture-merge-progress".into()).spawn(move || read_progress(stdout, |written| {
        if let Ok(mut current) = reported.lock() { *current = (written, Instant::now()); }
    })) {
        Ok(reader) => reader,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); record(&session.lock_or_recover(), "progress-reader-start-failed", json!({"error":error.to_string()})); return Err("capture_merge_failed"); }
    };
    record(
        &session.lock_or_recover(),
        "merge-started",
        json!({"pid":child.id(),"generation":tracks[0].generation,"timeoutMs":ceiling.as_millis(),"stallMs":STALL_LIMIT.as_millis()}),
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
                &session.lock_or_recover(),
                "stderr-reader-start-failed",
                json!({"error":error.to_string()}),
            );
            return Err("capture_merge_failed");
        }
    };
    let outcome = loop {
        if session
            .lock()
            .map_or(true, |current| current.snapshot.state == "interrupted")
        {
            let _ = child.kill();
            let _ = child.wait();
            record(
                &session.lock_or_recover(),
                "merge-interrupted",
                json!({"elapsedMs":started.elapsed().as_millis()}),
            );
            break Err("capture_merge_failed");
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                record(
                    &session.lock_or_recover(),
                    "merge-exited",
                    json!({"exitCode":status.code(),"success":status.success(),"elapsedMs":started.elapsed().as_millis()}),
                );
                break if status.success() { Ok(()) } else { Err("capture_merge_failed") };
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                record(
                    &session.lock_or_recover(),
                    "merge-wait-failed",
                    json!({"error":error.to_string()}),
                );
                break Err("capture_merge_failed");
            }
            Ok(None) => {
                let (written, last) = *advance.lock_or_recover();
                let idle = last.elapsed();
                let stopped = if stalled(idle) {
                    Some(("merge-stalled", "capture_merge_stalled"))
                } else if started.elapsed() >= ceiling {
                    Some(("merge-timeout", "capture_merge_timeout"))
                } else {
                    None
                };
                if let Some((stage, error)) = stopped {
                    let _ = child.kill();
                    let _ = child.wait();
                    record(
                        &session.lock_or_recover(),
                        stage,
                        json!({"elapsedMs":started.elapsed().as_millis(),"idleMs":idle.as_millis(),"writtenBytes":written}),
                    );
                    break Err(error);
                }
                if let Some(merge) = session.lock_or_recover().runtime.merge.as_mut() {
                    merge.processed_bytes = written;
                    merge.idle_seconds = idle.as_secs();
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
    };
    match reader.join() {
        Ok(Ok(())) => {}
        outcome => {
            record(
                &session.lock_or_recover(),
                "stderr-read-failed",
                json!({"error":format!("{outcome:?}")}),
            );
            eprintln!("capture merge stderr collection failed");
        }
    }
    let out_time_us = progress.join().ok().and_then(Result::ok).unwrap_or(0);
    let expected: Vec<_> = tracks.iter().map(|track| if track.mime.starts_with("video/") { 1 } else { 2 }).collect();
    let container_valid = matches(output, &expected);
    record(&session.lock_or_recover(), "output-validation", json!({"exitSuccess":outcome.is_ok(),"outTimeUs":out_time_us,"containerValid":container_valid,"expectedStreams":expected.len()}));
    outcome?;
    if out_time_us > 0 && container_valid { Ok(()) } else { Err("capture_merge_failed") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_limit_grows_with_the_segment() {
        assert_eq!(merge_ceiling(0), Duration::from_secs(120));
        assert_eq!(merge_ceiling(1024 * 1024 * 1024), Duration::from_secs(120 + 102));
        assert_eq!(merge_ceiling(64 * 1024 * 1024 * 1024), Duration::from_secs(120 + 6553));
    }

    #[test]
    fn regenerating_forgets_only_finalization_failures() {
        for code in FINALIZATION_ERRORS {
            let mut error = Some(code.to_string());
            clear_finalization_error(&mut error);
            assert_eq!(error, None, "{code}");
        }
        for code in ["capture_source_unavailable", "capture_host_stopped", "capture_disconnected"] {
            let mut error = Some(code.to_string());
            clear_finalization_error(&mut error);
            assert_eq!(error.as_deref(), Some(code));
        }
    }

    #[test]
    fn a_minute_without_progress_is_a_stall() {
        assert!(!stalled(Duration::from_secs(59)));
        assert!(stalled(Duration::from_secs(60)));
    }
}
