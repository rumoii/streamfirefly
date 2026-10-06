use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

const PREFIX_LIMIT: usize = 512 * 1024 + 64;
#[derive(Default, Debug, PartialEq)]
pub(crate) struct Inspection {
    pub(crate) initialized: bool,
    pub(crate) media: bool,
}

fn box_at(data: &[u8], offset: usize) -> Option<(usize, usize, &[u8])> {
    let head = data.get(offset..offset.checked_add(8)?)?;
    let size = u32::from_be_bytes(head[..4].try_into().ok()?) as usize;
    let (size, header) = if size == 1 {
        (usize::try_from(u64::from_be_bytes(data.get(offset + 8..offset + 16)?.try_into().ok()?)).ok()?, 16)
    } else { (size, 8) };
    if size < header { return None; }
    Some((size, header, &head[4..8]))
}
fn children(data: &[u8]) -> Option<Vec<&[u8]>> {
    let mut offset = 0;
    let mut types = Vec::new();
    while offset < data.len() {
        let (size, header, kind) = box_at(data, offset)?;
        let end = offset.checked_add(size)?;
        let body = data.get(offset + header..end)?;
        if [b"trak".as_slice(), b"mdia", b"minf", b"stbl", b"mvex"].contains(&kind) { children(body)?; }
        types.push(kind);
        offset = end;
    }
    Some(types)
}
fn mp4(data: &[u8], file_length: u64) -> Inspection {
    let mut result = Inspection::default();
    let mut ftyp = false;
    let mut offset = 0;
    while let Some((size, header, kind)) = box_at(data, offset) {
        let Some(end) = offset.checked_add(size) else { break };
        if kind == b"moof" || kind == b"mdat" {
            result.media = size > header && file_length > (offset + header) as u64;
            break;
        }
        let Some(body) = data.get(offset + header..end) else { break };
        if kind == b"ftyp" { ftyp = body.len() >= 8; }
        if kind == b"moov" {
            result.initialized = ftyp && children(body).is_some_and(|types| types.contains(&b"mvhd".as_slice()) && types.contains(&b"trak".as_slice()));
            if !result.initialized { break; }
        }
        offset = end;
    }
    result
}
fn vint(data: &[u8], offset: usize, id: bool) -> Option<(u64, usize, bool)> {
    let first = *data.get(offset)?;
    let width = first.leading_zeros() as usize + 1;
    if width > if id { 4 } else { 8 } { return None; }
    let bytes = data.get(offset..offset.checked_add(width)?)?;
    let mut value = if id { first as u64 } else { first as u64 & (0xffu64 >> width) };
    for byte in &bytes[1..] { value = (value << 8) | *byte as u64; }
    let unknown = !id && value == (1u64 << (7 * width)) - 1;
    Some((value, width, unknown))
}
fn element(data: &[u8], offset: usize) -> Option<(u64, usize, Option<usize>)> {
    let (id, a, _) = vint(data, offset, true)?;
    let (size, b, unknown) = vint(data, offset + a, false)?;
    let start = offset.checked_add(a + b)?;
    Some((id, start, if unknown { None } else { Some(start.checked_add(usize::try_from(size).ok()?)?) }))
}
fn ebml_children(data: &[u8], required: Option<u64>) -> bool {
    let mut offset = 0;
    let mut found = required.is_none() && !data.is_empty();
    while offset < data.len() {
        let Some((id, start, Some(end))) = element(data, offset) else { return false };
        let Some(body) = data.get(start..end) else { return false };
        if id == 0xae && !ebml_children(body, None) { return false; }
        found |= required == Some(id);
        offset = end;
    }
    found
}
fn webm(data: &[u8]) -> Inspection {
    let mut result = Inspection::default();
    let Some((0x1a45dfa3, start, Some(end))) = element(data, 0) else { return result };
    if !data.get(start..end).is_some_and(|body| ebml_children(body, None)) { return result; }
    let Some((0x18538067, mut offset, segment_end)) = element(data, end) else { return result };
    let mut info = false;
    let mut tracks = false;
    while offset < data.len() {
        let Some((id, start, end)) = element(data, offset) else { break };
        if id == 0x1f43b675 { result.media = data.len() > start; break; }
        let Some(end) = end else { break };
        if segment_end.is_some_and(|limit| end > limit) { break; }
        let Some(body) = data.get(start..end) else { break };
        if id == 0x1549a966 { info = ebml_children(body, None); }
        if id == 0x1654ae6b { tracks = ebml_children(body, Some(0xae)); }
        result.initialized = info && tracks;
        offset = end;
    }
    result
}
pub(crate) fn inspect(data: &[u8], mime: &str, file_length: u64) -> Inspection {
    if mime.contains("webm") { webm(data) } else { mp4(data, file_length) }
}
pub(crate) fn inspect_file(path: &Path, mime: &str) -> io::Result<Inspection> {
    let file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut prefix = Vec::new();
    file.take(PREFIX_LIMIT as u64).read_to_end(&mut prefix)?;
    Ok(inspect(&prefix, mime, length))
}

#[cfg(test)]
mod tests {
    use super::inspect;
    fn box_bytes(kind: &[u8], body: &[u8]) -> Vec<u8> {
        [((body.len() + 8) as u32).to_be_bytes().as_slice(), kind, body].concat()
    }
    #[test]
    fn mp4_requires_complete_structural_initialization() {
        let moov = box_bytes(b"moov", &[box_bytes(b"mvhd", &[0; 16]), box_bytes(b"trak", &[])].concat());
        let init = [box_bytes(b"ftyp", b"isom\0\0\0\0"), moov].concat();
        assert!(inspect(&init, "video/mp4", init.len() as u64).initialized);
        for length in 0..init.len() { assert!(!inspect(&init[..length], "video/mp4", length as u64).initialized); }
        assert!(!inspect(&box_bytes(b"moov", &[]), "video/mp4", 8).initialized);
        assert!(!inspect(&init, "video/mp4", init.len() as u64).media);
        let media = [init, box_bytes(b"moof", &[0; 8])].concat();
        assert!(inspect(&media, "video/mp4", media.len() as u64).media);
    }
    #[test]
    fn webm_requires_info_and_tracks_before_media() {
        let init = [0x1a,0x45,0xdf,0xa3,0x84,0x42,0x86,0x81,1,0x18,0x53,0x80,0x67,0xff,0x15,0x49,0xa9,0x66,0x84,0x2a,0xd7,0xb1,0x80,0x16,0x54,0xae,0x6b,0x85,0xae,0x83,0xd7,0x81,1];
        assert!(inspect(&init, "audio/webm", init.len() as u64).initialized);
        for length in 0..init.len() { assert!(!inspect(&init[..length], "audio/webm", length as u64).initialized); }
        let media = [init.as_slice(), &[0x1f,0x43,0xb6,0x75,0xff,0xe7,0x81,0]].concat();
        assert!(inspect(&media, "audio/webm", media.len() as u64).media);
    }
}
