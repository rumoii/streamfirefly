use crate::capture_model::{Session, Track};
use crate::capture_format::inspect_file;
use crate::persistence::replace_file;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};
const MAX_CHUNK: usize = 256 * 1024;
const MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;
pub(crate) fn save(session: &Session) -> io::Result<()> {
    let target = session.directory.join("capture.json");
    let temporary = session.directory.join("capture.tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(&session.snapshot)?)?;
    file.sync_all()?;
    drop(file);
    replace_file(&temporary, &target)
}

pub(crate) fn append(session: &Arc<Mutex<Session>>, frame: &[u8]) -> Result<Value, String> {
    if frame.len() < 5 || frame.len() > MAX_CHUNK + 4096 {
        return Err("capture_frame_invalid".into());
    }
    let length = u32::from_le_bytes(frame[..4].try_into().unwrap()) as usize;
    if length > 4092 || length + 4 >= frame.len() {
        return Err("capture_metadata_invalid".into());
    }
    let metadata: Value =
        serde_json::from_slice(&frame[4..length + 4]).map_err(|_| "capture_metadata_invalid")?;
    let id = metadata["track"]
        .as_u64()
        .filter(|value| *value < 32)
        .ok_or("capture_track_invalid")? as u32;
    let sequence = metadata["sequence"]
        .as_u64()
        .ok_or("capture_sequence_invalid")?;
    let generation = metadata["generation"]
        .as_u64()
        .filter(|value| *value < 32)
        .ok_or("capture_generation_invalid")? as u32;
    let mime = metadata["mime"]
        .as_str()
        .filter(|value| {
            value.len() < 200
                && ["video/mp4", "audio/mp4", "video/webm", "audio/webm"]
                    .iter()
                    .any(|prefix| value.starts_with(prefix))
        })
        .ok_or("capture_codec_unsupported")?;
    let data = &frame[length + 4..];
    if data.len() > MAX_CHUNK {
        return Err("capture_chunk_too_large".into());
    }
    let mut current = session.lock().map_err(|_| "capture_unavailable")?;
    if current.stop {
        return Err("capture_stopped".into());
    }
    if current.snapshot.bytes + data.len() as u64 > MAX_BYTES {
        return Err("capture_quota_exceeded".into());
    }
    let index = match current
        .snapshot
        .tracks
        .iter()
        .position(|track| track.id == id)
    {
        Some(index) => index,
        None => {
            if current.snapshot.tracks.len() >= 32 || sequence != 0 {
                return Err("capture_track_limit_or_missing_start".into());
            }
            let extension = if mime.contains("webm") { "webm" } else { "mp4" };
            current.snapshot.tracks.push(Track {
                generation,
                id,
                mime: mime.into(),
                bytes: 0,
                next_sequence: 0,
                last_chunk_size: 0,
                initialized: false,
                file: format!("track-{id}.{extension}"),
            });
            current.snapshot.tracks.len() - 1
        }
    };
    let track = &current.snapshot.tracks[index];
    if track.mime != mime || track.generation != generation {
        return Err("capture_codec_changed".into());
    }
    if sequence < track.next_sequence {
        if sequence + 1 != track.next_sequence || track.last_chunk_size != data.len() as u64 {
            return Err("capture_replay_invalid".into());
        }
        let mut saved = vec![0; data.len()];
        let mut file = fs::File::open(current.directory.join(&track.file))
            .map_err(|_| "capture_read_failed")?;
        file.seek(SeekFrom::Start(track.bytes - track.last_chunk_size))
            .and_then(|_| file.read_exact(&mut saved))
            .map_err(|_| "capture_read_failed")?;
        if saved != data {
            return Err("capture_replay_conflict".into());
        }
        return Ok(json!({"track":id,"sequence":sequence,"duplicate":true}));
    }
    if sequence != track.next_sequence {
        return Err("capture_sequence_gap".into());
    }
    let path = current.directory.join(&track.file);
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|_| "capture_write_failed")?;
    file.write_all(data)
        .and_then(|_| file.sync_data())
        .map_err(|_| "capture_write_failed")?;
    current.snapshot.tracks[index].bytes += data.len() as u64;
    current.snapshot.tracks[index].next_sequence += 1;
    current.snapshot.tracks[index].last_chunk_size = data.len() as u64;
    current.snapshot.bytes += data.len() as u64;
    if !current.snapshot.tracks[index].initialized {
        current.snapshot.tracks[index].initialized = inspect_file(&current.directory.join(&current.snapshot.tracks[index].file), mime)
            .map_err(|_| "capture_read_failed")?.initialized;
    }
    save(&current).map_err(|_| "capture_checkpoint_failed")?;
    Ok(json!({"track":id,"sequence":sequence,"bytes":current.snapshot.bytes}))
}
