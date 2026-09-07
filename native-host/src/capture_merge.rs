use crate::capture_model::{Session, Track};
use crate::capture_storage::save;
use crate::media_process::bundled_tool;
use crate::persistence::replace_file;
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
        (current.directory.clone(), current.snapshot.tracks.clone())
    };
    let mut generations: BTreeMap<u32, Vec<Track>> = BTreeMap::new();
    for track in tracks {
        generations.entry(track.generation).or_default().push(track);
    }
    let mut outputs = Vec::new();
    let mut complete = !generations.is_empty();
    let mut failure = "capture_initialization_missing";
    for (generation, tracks) in &generations {
        let initialized = tracks.iter().all(|track| {
            track.initialized
                && fs::metadata(directory.join(&track.file))
                    .is_ok_and(|metadata| metadata.len() == track.bytes)
        });
        if !initialized {
            complete = false;
            continue;
        }
        let output = directory.join(format!("capture-{generation}.mkv"));
        let temporary = directory.join(format!("capture-{generation}.pending.mkv"));
        if merge(&directory, tracks, &temporary, session)
            && replace_file(&temporary, &output).is_ok()
        {
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
    current.snapshot.state = if complete && current.snapshot.error.is_none() {
        "complete"
    } else {
        "partial"
    }
    .into();
    current.snapshot.output = outputs.first().cloned();
    current.snapshot.outputs = outputs;
    if !complete && current.snapshot.error.is_none() {
        current.snapshot.error = Some(failure.into());
    }
    if save(&current).is_err() {
        current.snapshot.state = "partial".into();
        current.snapshot.error = Some("capture_checkpoint_failed".into());
    }
}

fn merge(directory: &Path, tracks: &[Track], output: &Path, session: &Arc<Mutex<Session>>) -> bool {
    let mut command = Command::new(bundled_tool("ffmpeg.exe"));
    command.args(["-nostdin", "-y", "-v", "error"]);
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
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        if session
            .lock()
            .map_or(true, |current| current.snapshot.state == "interrupted")
        {
            let _ = child.kill();
            let _ = child.wait();
            return false;
        }
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
            Ok(None) => thread::sleep(Duration::from_millis(100)),
        }
    }
}
