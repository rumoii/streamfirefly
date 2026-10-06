use std::collections::HashSet;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "invalid capture container") }
fn vint(file: &mut File, id: bool) -> io::Result<(u64, bool)> {
    let mut byte = [0]; file.read_exact(&mut byte)?;
    let width = byte[0].leading_zeros() as usize + 1;
    if width > if id { 4 } else { 8 } { return Err(invalid()); }
    let mut value = if id { byte[0] as u64 } else { byte[0] as u64 & (255u64 >> width) };
    for _ in 1..width { file.read_exact(&mut byte)?; value = (value << 8) | byte[0] as u64; }
    Ok((value, !id && value == (1u64 << (width * 7)) - 1))
}
fn element(file: &mut File, limit: u64) -> io::Result<(u64, u64, bool)> {
    let (id, _) = vint(file, true)?;
    let (length, unknown) = vint(file, false)?;
    let start = file.stream_position()?;
    let end = if unknown { limit } else { start.checked_add(length).ok_or_else(invalid)? };
    if start > limit || end > limit { return Err(invalid()); }
    Ok((id, end, unknown))
}
fn integer(file: &mut File, end: u64) -> io::Result<u64> {
    let length = end.checked_sub(file.stream_position()?).ok_or_else(invalid)?;
    if length == 0 || length > 8 { return Err(invalid()); }
    let mut value = 0;
    for _ in 0..length { let mut byte = [0]; file.read_exact(&mut byte)?; value = (value << 8) | byte[0] as u64; }
    Ok(value)
}
fn track(file: &mut File, end: u64) -> io::Result<(u64, u64)> {
    let mut number = None; let mut kind = None; let mut codec = false;
    while file.stream_position()? < end {
        let (id, next, unknown) = element(file, end)?;
        if unknown { return Err(invalid()); }
        match id {
            0xd7 => { if number.is_some() { return Err(invalid()); } number = Some(integer(file, next)?); }
            0x83 => { if kind.is_some() { return Err(invalid()); } kind = Some(integer(file, next)?); }
            0x86 => {
                let length = next - file.stream_position()?;
                if length == 0 || length > 200 || codec { return Err(invalid()); }
                let mut bytes = vec![0; length as usize]; file.read_exact(&mut bytes)?;
                codec = bytes.iter().all(|byte| byte.is_ascii_graphic());
            }
            _ => {}
        }
        file.seek(SeekFrom::Start(next))?;
    }
    match (number, kind, codec) { (Some(number), Some(kind @ (1 | 2)), true) if number > 0 => Ok((number, kind)), _ => Err(invalid()) }
}
pub(crate) fn stream_types(path: &Path) -> io::Result<Vec<u64>> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let (id, header_end, unknown) = element(&mut file, length)?;
    if id != 0x1a45dfa3 || unknown { return Err(invalid()); }
    let mut doc_type = false;
    while file.stream_position()? < header_end {
        let (id, end, unknown) = element(&mut file, header_end)?;
        if unknown { return Err(invalid()); }
        if id == 0x4282 {
            let size = end - file.stream_position()?;
            if size > 16 { return Err(invalid()); }
            let mut value = vec![0; size as usize]; file.read_exact(&mut value)?;
            doc_type = value == b"matroska" || value == b"webm";
        }
        file.seek(SeekFrom::Start(end))?;
    }
    if !doc_type { return Err(invalid()); }
    let (id, segment_end, _) = element(&mut file, length)?;
    if id != 0x18538067 { return Err(invalid()); }
    let mut types = Vec::new(); let mut numbers = HashSet::new(); let mut tracks_seen = false;
    while file.stream_position()? < segment_end {
        let (id, end, unknown) = element(&mut file, segment_end)?;
        if id == 0x1654ae6b {
            if unknown || tracks_seen { return Err(invalid()); } tracks_seen = true;
            while file.stream_position()? < end {
                let (id, track_end, unknown) = element(&mut file, end)?;
                if unknown { return Err(invalid()); }
                if id == 0xae {
                    if types.len() >= 32 { return Err(invalid()); }
                    let (number, kind) = track(&mut file, track_end)?;
                    if !numbers.insert(number) { return Err(invalid()); } types.push(kind);
                }
                file.seek(SeekFrom::Start(track_end))?;
            }
        } else if unknown && id != 0x1f43b675 { return Err(invalid()); }
        file.seek(SeekFrom::Start(end))?;
    }
    if !tracks_seen || types.is_empty() { return Err(invalid()); }
    types.sort_unstable(); Ok(types)
}
pub(crate) fn matches(path: &Path, expected: &[u64]) -> bool {
    let mut expected = expected.to_vec(); expected.sort_unstable();
    stream_types(path).is_ok_and(|actual| actual == expected)
}
pub(crate) fn read_progress(mut input: impl Read) -> io::Result<u64> {
    let mut buffer = [0; 4096]; let mut line = Vec::new(); let mut discard = false; let mut time = 0;
    loop {
        let count = input.read(&mut buffer)?; if count == 0 { break; }
        for byte in &buffer[..count] {
            if *byte == b'\n' {
                if !discard { if let Ok(text) = std::str::from_utf8(&line) { if let Some(value) = text.trim_end().strip_prefix("out_time_us=").and_then(|value| value.parse::<u64>().ok()) { time = time.max(value); } } }
                line.clear(); discard = false;
            } else if line.len() < 256 { line.push(*byte); } else { discard = true; }
        }
    }
    Ok(time)
}

#[cfg(test)]
mod tests {
    use super::{matches, read_progress};
    use std::fs;
    use std::io::Cursor;
    fn element(id: &[u8], body: &[u8]) -> Vec<u8> { assert!(body.len() < 127); [id, &[128 | body.len() as u8], body].concat() }
    #[test]
    fn progress_requires_positive_microseconds_and_is_bounded() {
        assert_eq!(read_progress(Cursor::new(b"out_time_us=0\nout_time_ms=999\nprogress=end\n")).unwrap(), 0);
        assert_eq!(read_progress(Cursor::new(b"out_time_us=N/A\nout_time_us=-1\nout_time_us=1234\nout_time_us=1\n")).unwrap(), 1234);
        assert_eq!(read_progress(Cursor::new([vec![b'x'; 10000], b"\nout_time_us=12\n".to_vec()].concat())).unwrap(), 12);
    }
    #[test]
    fn container_requires_complete_tracks_with_matching_types() {
        let directory = std::env::temp_dir().join(format!("capture-output-{}", uuid::Uuid::new_v4())); fs::create_dir(&directory).unwrap(); let path = directory.join("output.mkv");
        let header = element(&[0x1a,0x45,0xdf,0xa3], &element(&[0x42,0x82], b"matroska"));
        let entry = |number, kind| element(&[0xae], &[element(&[0xd7], &[number]), element(&[0x83], &[kind]), element(&[0x86], b"V_TEST")].concat());
        let tracks = element(&[0x16,0x54,0xae,0x6b], &[entry(1,1), entry(2,2)].concat());
        let valid = [header.clone(), vec![0x18,0x53,0x80,0x67,0xff], tracks.clone()].concat(); fs::write(&path, &valid).unwrap();
        assert!(matches(&path, &[1,2])); assert!(!matches(&path, &[1])); assert!(!matches(&path, &[1,1]));
        for length in 0..valid.len() { fs::write(&path, &valid[..length]).unwrap(); assert!(!matches(&path, &[1,2])); }
        let duplicate = [header, vec![0x18,0x53,0x80,0x67,0xff], element(&[0x16,0x54,0xae,0x6b], &[entry(1,1), entry(1,2)].concat())].concat(); fs::write(&path, duplicate).unwrap(); assert!(!matches(&path, &[1,2]));
        assert_eq!(directory.parent().unwrap().canonicalize().unwrap(), std::env::temp_dir().canonicalize().unwrap()); fs::remove_dir_all(directory).unwrap();
    }
}
