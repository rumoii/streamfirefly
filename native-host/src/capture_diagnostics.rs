use crate::capture_model::Session;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn record(session: &Session, stage: &str, details: Value) {
    if let Err(error) = write_record(&session.directory, stage, details) {
        eprintln!("capture diagnostic write failed: {stage}: {error}");
        let _ = fs::write(
            session.directory.join("diagnostic-error.txt"),
            error.to_string(),
        );
    }
}

fn write_record(directory: &Path, stage: &str, details: Value) -> io::Result<()> {
    let target = directory.join("diagnostics.json");
    if fs::metadata(&target).is_ok_and(|metadata| metadata.len() > 1024 * 1024) {
        return Err(io::Error::other("capture diagnostics exceeded size limit"));
    }
    let mut records: VecDeque<Value> = match fs::read(&target) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => VecDeque::new(),
        Err(error) => return Err(error),
    };
    records.push_back(json!({"stage":stage,"atMs":SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),"details":details}));
    while records.len() > 128 {
        records.pop_front();
    }
    fs::write(target, serde_json::to_vec(&records)?)
}

pub(crate) fn drain_stderr(mut reader: impl Read, target: &Path) -> io::Result<()> {
    let mut tail = VecDeque::new();
    let mut buffer = [0; 4096];
    let mut failure = fs::write(target, []).err();
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        tail.extend(&buffer[..count]);
        while tail.len() > 16 * 1024 {
            tail.pop_front();
        }
        if let Err(error) = fs::write(target, tail.make_contiguous()) {
            failure = Some(error);
        }
    }
    failure.map_or(Ok(()), Err)
}

/// Reads a capture directory's diagnostic records and FFmpeg error tails for a user-requested report.
/// Missing or unreadable files are reported by name instead of failing the whole report.
pub(crate) fn collect(directory: &Path, stderr_budget: usize) -> Value {
    let mut issues = Vec::new();
    let records = match read_bounded(&directory.join("diagnostics.json"), 2 * 1024 * 1024) {
        Ok(Some(bytes)) => serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
            issues.push(json!({"file":"diagnostics.json","issue":"invalid"}));
            Value::Null
        }),
        Ok(None) => {
            issues.push(json!({"file":"diagnostics.json","issue":"missing"}));
            Value::Null
        }
        Err(_) => {
            issues.push(json!({"file":"diagnostics.json","issue":"unreadable"}));
            Value::Null
        }
    };
    let mut names = fs::read_dir(directory)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().into_string().ok())
                .filter(|name| {
                    name == "diagnostic-error.txt"
                        || name.starts_with("ffmpeg-stderr-") && name.ends_with(".txt")
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    let mut remaining = stderr_budget;
    let mut logs = Vec::new();
    for name in names {
        match read_bounded(&directory.join(&name), 64 * 1024) {
            Ok(Some(bytes)) => {
                let tail = &bytes[bytes.len().saturating_sub(remaining)..];
                remaining -= tail.len();
                logs.push(json!({"file":name,"bytes":bytes.len(),"text":String::from_utf8_lossy(tail),"truncated":tail.len() < bytes.len()}));
            }
            Ok(None) => {}
            Err(_) => issues.push(json!({"file":name,"issue":"unreadable"})),
        }
    }
    json!({"records":records,"logs":logs,"issues":issues})
}

fn read_bounded(path: &Path, limit: u64) -> io::Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
        Ok(metadata) if !metadata.is_file() || metadata.len() > limit => {
            Err(io::Error::other("diagnostic file is not a bounded regular file"))
        }
        Ok(_) => fs::read(path).map(Some),
    }
}

#[cfg(test)]
mod tests {
    use super::{collect, drain_stderr, write_record};
    use std::fs;
    use std::io::Cursor;

    #[test]
    fn diagnostics_and_stderr_are_bounded() {
        let directory =
            std::env::temp_dir().join(format!("capture-diagnostics-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        for index in 0..140 {
            write_record(&directory, "test", serde_json::json!({"index":index})).unwrap();
        }
        let records: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(directory.join("diagnostics.json")).unwrap()).unwrap();
        assert_eq!(records.len(), 128);
        assert_eq!(records[0]["details"]["index"], 12);
        let target = directory.join("stderr.txt");
        let mut input = vec![b'a'; 32000];
        input.extend_from_slice(b"final error");
        drain_stderr(Cursor::new(input), &target).unwrap();
        let tail = fs::read(target).unwrap();
        assert_eq!(tail.len(), 16384);
        assert!(tail.ends_with(b"final error"));
        let missing = directory.join("missing").join("stderr.txt");
        assert!(drain_stderr(Cursor::new(vec![0; 32000]), &missing).is_err());
        fs::write(directory.join("ffmpeg-stderr-0.txt"), vec![b'x'; 300]).unwrap();
        fs::write(directory.join("ffmpeg-stderr-1.txt"), b"second failure").unwrap();
        fs::write(directory.join("track-0.mp4"), b"media").unwrap();
        let report = collect(&directory, 200);
        assert_eq!(report["records"].as_array().unwrap().len(), 128);
        let logs = report["logs"].as_array().unwrap();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0]["file"], "ffmpeg-stderr-0.txt");
        assert_eq!(logs[0]["text"].as_str().unwrap().len(), 200);
        assert_eq!(logs[0]["truncated"], true);
        assert_eq!(logs[1]["text"], "");
        fs::remove_file(directory.join("diagnostics.json")).unwrap();
        assert_eq!(collect(&directory, 200)["issues"][0]["issue"], "missing");
        assert_eq!(
            directory.parent().unwrap().canonicalize().unwrap(),
            std::env::temp_dir().canonicalize().unwrap()
        );
        assert!(directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("capture-diagnostics-"));
        fs::remove_dir_all(directory).unwrap();
    }
}
