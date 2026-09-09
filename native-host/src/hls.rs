use aes::Aes128;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

type Aes128CbcDec = cbc::Decryptor<Aes128>;

pub const CHECKPOINT_VERSION: u8 = 2;

pub use crate::segments::ByteRange;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KeySpec {
    pub method: String,
    pub uri: Option<String>,
    pub iv: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapSpec {
    pub id: String,
    pub uri: String,
    pub byte_range: Option<ByteRange>,
    pub key: Option<KeySpec>,
    pub local_name: String,
    pub state: String,
    pub bytes: u64,
    pub retries: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SegmentSpec {
    pub id: String,
    pub index: usize,
    pub sequence: u64,
    pub uri: String,
    pub duration: f64,
    pub title: String,
    pub byte_range: Option<ByteRange>,
    pub key: Option<KeySpec>,
    pub map_id: Option<String>,
    pub discontinuity: bool,
    pub local_name: String,
    pub state: String,
    pub bytes: u64,
    pub retries: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackCheckpoint {
    pub id: String,
    pub kind: String,
    pub language: Option<String>,
    pub label: Option<String>,
    pub duration: f64,
    pub maps: Vec<MapSpec>,
    pub segments: Vec<SegmentSpec>,
    #[serde(default)]
    pub end_list: bool,
    #[serde(default)]
    pub target_duration: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedManifest {
    pub text: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSubtitlePlan {
    pub language: Option<String>,
    pub label: Option<String>,
    pub extension: String,
    pub manifest: PersistedManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedPlan {
    pub version: u8,
    pub duration: f64,
    pub container: String,
    pub video_manifest: PersistedManifest,
    pub audio_manifest: Option<PersistedManifest>,
    pub subtitles: Vec<PersistedSubtitlePlan>,
    #[serde(default)]
    pub live: bool,
    #[serde(default)]
    pub poll_interval_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HlsCheckpoint {
    pub version: u8,
    pub task_id: String,
    pub plan: PersistedPlan,
    pub tracks: Vec<TrackCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyOverrideKind {
    Hex,
    Base64,
    Url,
}

#[derive(Debug, Clone)]
pub struct KeyOverride {
    pub kind: KeyOverrideKind,
    pub value: String,
    pub iv: Option<[u8; 16]>,
}

fn absolute(value: &str, base_url: &str) -> Result<String, String> {
    if value.starts_with("http://") || value.starts_with("https://") {
        return Ok(value.to_string());
    }
    let Some((prefix, _)) = base_url.rsplit_once('/') else {
        return Err("hls_manifest_url_invalid".into());
    };
    if value.starts_with('/') {
        let scheme = base_url.find("://").ok_or("hls_manifest_url_invalid")?;
        let authority_end = base_url[scheme + 3..]
            .find('/')
            .map(|index| scheme + 3 + index)
            .unwrap_or(base_url.len());
        return Ok(format!("{}{}", &base_url[..authority_end], value));
    }
    Ok(format!("{prefix}/{value}"))
}

fn parse_attributes(input: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    let bytes = input.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let Some(equal) = input[cursor..].find('=').map(|value| cursor + value) else {
            break;
        };
        let key = input[cursor..equal].trim().to_string();
        cursor = equal + 1;
        let value;
        if bytes.get(cursor) == Some(&b'"') {
            cursor += 1;
            let end = input[cursor..]
                .find('"')
                .map(|value| cursor + value)
                .unwrap_or(input.len());
            value = input[cursor..end].to_string();
            cursor = end.saturating_add(1);
        } else {
            let end = input[cursor..]
                .find(',')
                .map(|value| cursor + value)
                .unwrap_or(input.len());
            value = input[cursor..end].trim().to_string();
            cursor = end;
        }
        values.insert(key, value);
        if bytes.get(cursor) == Some(&b',') {
            cursor += 1;
        }
    }
    values
}

fn parse_byte_range(
    value: &str,
    uri: &str,
    next_offsets: &mut HashMap<String, u64>,
) -> Result<ByteRange, String> {
    let (length, explicit_start) = value
        .split_once('@')
        .map(|(length, start)| (length, Some(start)))
        .unwrap_or((value, None));
    let length = length
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "hls_byte_range_invalid".to_string())?;
    let start = match explicit_start {
        Some(value) => value
            .parse::<u64>()
            .map_err(|_| "hls_byte_range_invalid".to_string())?,
        None => *next_offsets
            .get(uri)
            .ok_or_else(|| "hls_byte_range_offset_missing".to_string())?,
    };
    next_offsets.insert(uri.to_string(), start.saturating_add(length));
    Ok(ByteRange { start, length })
}

fn extension_from_url(uri: &str, fallback: &str) -> String {
    let path = uri.split(['?', '#']).next().unwrap_or(uri);
    let extension = path
        .rsplit_once('.')
        .map(|(_, value)| value)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 8
                && value
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
        .unwrap_or(fallback);
    extension.to_ascii_lowercase()
}

fn parse_media_playlist_inner(
    id: &str,
    kind: &str,
    language: Option<String>,
    label: Option<String>,
    manifest: &PersistedManifest,
    allow_live: bool,
    mut next_offsets: HashMap<String, u64>,
    known_ranges: HashMap<(u64, String), ByteRange>,
) -> Result<TrackCheckpoint, String> {
    let lines: Vec<&str> = manifest
        .text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    if lines.first().copied() != Some("#EXTM3U") {
        return Err("hls_manifest_invalid".into());
    }
    let mut media_sequence = 0_u64;
    let mut pending_duration = None;
    let mut pending_title = String::new();
    let mut pending_range: Option<String> = None;
    let mut key: Option<KeySpec> = None;
    let mut current_map: Option<String> = None;
    let mut discontinuity = false;
    let mut end_list = false;
    let mut target_duration = None;
    let mut duration = 0.0_f64;
    let mut maps = Vec::new();
    let mut segments = Vec::new();
    for line in lines {
        if let Some(value) = line.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            media_sequence = value.trim().parse().unwrap_or(0);
        } else if let Some(value) = line.strip_prefix("#EXTINF:") {
            let (seconds, title) = value.split_once(',').unwrap_or((value, ""));
            pending_duration = Some(
                seconds
                    .parse::<f64>()
                    .ok()
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .ok_or_else(|| "hls_segment_duration_invalid".to_string())?,
            );
            pending_title = title.to_string();
        } else if let Some(value) = line.strip_prefix("#EXT-X-TARGETDURATION:") {
            target_duration = value.trim().parse::<f64>().ok();
        } else if let Some(value) = line.strip_prefix("#EXT-X-BYTERANGE:") {
            pending_range = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("#EXT-X-KEY:") {
            let attributes = parse_attributes(value);
            if attributes
                .get("KEYFORMAT")
                .is_some_and(|value| value != "identity")
            {
                return Err("hls_drm_unsupported".into());
            }
            let method = attributes
                .get("METHOD")
                .map(String::as_str)
                .unwrap_or("NONE")
                .to_ascii_uppercase();
            key = if method == "NONE" {
                None
            } else {
                Some(KeySpec {
                    method,
                    uri: attributes
                        .get("URI")
                        .map(|value| absolute(value, &manifest.base_url))
                        .transpose()?,
                    iv: attributes.get("IV").cloned(),
                })
            };
        } else if let Some(value) = line.strip_prefix("#EXT-X-MAP:") {
            if key
                .as_ref()
                .is_some_and(|value| value.method == "AES-128" && value.iv.as_deref().is_none())
            {
                return Err("hls_map_iv_required".into());
            }
            let attributes = parse_attributes(value);
            let uri = attributes
                .get("URI")
                .ok_or_else(|| "hls_map_uri_missing".to_string())
                .and_then(|value| absolute(value, &manifest.base_url))?;
            let byte_range = attributes
                .get("BYTERANGE")
                .map(|value| parse_byte_range(value, &uri, &mut next_offsets))
                .transpose()?;
            let map_id = format!("{id}:map:{}", maps.len());
            let extension = extension_from_url(&uri, "mp4");
            maps.push(MapSpec {
                id: map_id.clone(),
                uri,
                byte_range,
                key: key.clone(),
                local_name: format!("maps/{:04}.{extension}", maps.len()),
                state: "pending".into(),
                bytes: 0,
                retries: 0,
                error: None,
            });
            current_map = Some(map_id);
        } else if line == "#EXT-X-DISCONTINUITY" {
            discontinuity = true;
        } else if line.starts_with("#EXT-X-PART:") || line.starts_with("#EXT-X-PRELOAD-HINT:") {
            return Err("hls_ll_part_unsupported".into());
        } else if line == "#EXT-X-ENDLIST" {
            end_list = true;
        } else if !line.starts_with('#') {
            let segment_duration = pending_duration
                .take()
                .ok_or_else(|| "hls_segment_duration_missing".to_string())?;
            let uri = absolute(line, &manifest.base_url)?;
            let index = segments.len();
            let sequence = media_sequence.saturating_add(index as u64);
            let byte_range = pending_range
                .take()
                .map(|value| {
                    if !value.contains('@') {
                        if let Some(range) = known_ranges.get(&(sequence, uri.clone())).cloned() {
                            next_offsets
                                .insert(uri.clone(), range.start.saturating_add(range.length));
                            return Ok(range);
                        }
                    }
                    parse_byte_range(&value, &uri, &mut next_offsets)
                })
                .transpose()?;
            let extension =
                extension_from_url(&uri, if kind == "subtitle" { "vtt" } else { "bin" });
            segments.push(SegmentSpec {
                id: format!("{id}:segment:{index}"),
                index,
                sequence,
                uri,
                duration: segment_duration,
                title: std::mem::take(&mut pending_title),
                byte_range,
                key: key.clone(),
                map_id: current_map.clone(),
                discontinuity,
                local_name: format!("segments/{index:06}.{extension}"),
                state: "pending".into(),
                bytes: 0,
                retries: 0,
                error: None,
            });
            discontinuity = false;
            duration += segment_duration;
        }
    }
    if !allow_live && !end_list {
        return Err("hls_live_not_supported".into());
    }
    if segments.is_empty() {
        return Err("hls_segments_empty".into());
    }
    Ok(TrackCheckpoint {
        id: id.into(),
        kind: kind.into(),
        language,
        label,
        duration,
        maps,
        segments,
        end_list,
        target_duration,
    })
}

pub fn parse_media_playlist(
    id: &str,
    kind: &str,
    language: Option<String>,
    label: Option<String>,
    manifest: &PersistedManifest,
) -> Result<TrackCheckpoint, String> {
    parse_media_playlist_inner(
        id,
        kind,
        language,
        label,
        manifest,
        false,
        HashMap::new(),
        HashMap::new(),
    )
}

pub fn parse_live_media_playlist(
    id: &str,
    kind: &str,
    language: Option<String>,
    label: Option<String>,
    manifest: &PersistedManifest,
) -> Result<TrackCheckpoint, String> {
    parse_media_playlist_inner(
        id,
        kind,
        language,
        label,
        manifest,
        true,
        HashMap::new(),
        HashMap::new(),
    )
}

pub fn parse_live_media_playlist_after(
    previous: &TrackCheckpoint,
    manifest: &PersistedManifest,
) -> Result<TrackCheckpoint, String> {
    let mut offsets = HashMap::new();
    let known_ranges = previous
        .segments
        .iter()
        .filter_map(|item| {
            item.byte_range
                .clone()
                .map(|range| ((item.sequence, item.uri.clone()), range))
        })
        .collect();
    for (uri, range) in previous
        .maps
        .iter()
        .filter_map(|item| item.byte_range.as_ref().map(|range| (&item.uri, range)))
        .chain(
            previous
                .segments
                .iter()
                .filter_map(|item| item.byte_range.as_ref().map(|range| (&item.uri, range))),
        )
    {
        offsets
            .entry(uri.clone())
            .and_modify(|value: &mut u64| {
                *value = (*value).max(range.start.saturating_add(range.length))
            })
            .or_insert_with(|| range.start.saturating_add(range.length));
    }
    parse_media_playlist_inner(
        &previous.id,
        &previous.kind,
        previous.language.clone(),
        previous.label.clone(),
        manifest,
        true,
        offsets,
        known_ranges,
    )
}

fn same_range(left: &Option<ByteRange>, right: &Option<ByteRange>) -> bool {
    left == right
}

pub fn merge_live_window(
    checkpoint: &mut TrackCheckpoint,
    window: TrackCheckpoint,
) -> Result<usize, String> {
    if checkpoint.id != window.id || checkpoint.kind != window.kind {
        return Err("hls_live_track_mismatch".into());
    }
    let mut map_ids = HashMap::new();
    for map in window.maps {
        let existing = checkpoint.maps.iter().find(|item| {
            item.uri == map.uri
                && same_range(&item.byte_range, &map.byte_range)
                && item.key == map.key
        });
        let id = if let Some(existing) = existing {
            existing.id.clone()
        } else {
            let index = checkpoint.maps.len();
            let id = format!("{}:map:{index}", checkpoint.id);
            checkpoint.maps.push(MapSpec {
                id: id.clone(),
                local_name: format!("maps/{index:04}.{}", extension_from_url(&map.uri, "mp4")),
                ..map.clone()
            });
            id
        };
        map_ids.insert(map.id, id);
    }
    let mut added = 0;
    for mut segment in window.segments {
        let duplicate = checkpoint.segments.iter().any(|item| {
            item.sequence == segment.sequence
                && item.uri == segment.uri
                && same_range(&item.byte_range, &segment.byte_range)
        });
        if duplicate {
            continue;
        }
        let index = checkpoint.segments.len();
        segment.id = format!("{}:segment:{index}", checkpoint.id);
        segment.index = index;
        segment.local_name = format!(
            "segments/{index:06}.{}",
            extension_from_url(
                &segment.uri,
                if checkpoint.kind == "subtitle" {
                    "vtt"
                } else {
                    "bin"
                }
            )
        );
        segment.map_id = segment
            .map_id
            .and_then(|map_id| map_ids.get(&map_id).cloned());
        checkpoint.duration += segment.duration;
        checkpoint.segments.push(segment);
        added += 1;
    }
    checkpoint.end_list = window.end_list;
    checkpoint.target_duration = window.target_duration.or(checkpoint.target_duration);
    Ok(added)
}

pub fn save_checkpoint(path: &Path, checkpoint: &HlsCheckpoint) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(checkpoint).map_err(|error| error.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    let backup = path.with_extension("bak");
    let _ = fs::remove_file(&backup);
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(error.to_string());
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

pub fn load_checkpoint(path: &Path) -> Result<HlsCheckpoint, String> {
    let read = |candidate: &Path| {
        let bytes = fs::read(candidate).map_err(|error| error.to_string())?;
        serde_json::from_slice::<HlsCheckpoint>(&bytes)
            .map_err(|_| "hls_checkpoint_invalid".to_string())
    };
    let mut checkpoint = read(path).or_else(|primary_error| {
        let backup = path.with_extension("bak");
        if backup.is_file() {
            read(&backup)
        } else {
            Err(primary_error)
        }
    })?;
    if !matches!(checkpoint.version, 1 | CHECKPOINT_VERSION) {
        return Err("hls_checkpoint_version_unsupported".into());
    }
    checkpoint.version = CHECKPOINT_VERSION;
    Ok(checkpoint)
}

pub fn parse_key_override(
    kind: &str,
    value: &str,
    iv: Option<&str>,
) -> Result<KeyOverride, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("hls_key_override_empty".into());
    }
    let kind = match kind {
        "hex" => {
            decode_hex_16(value, true)?;
            KeyOverrideKind::Hex
        }
        "base64" => {
            let bytes = STANDARD
                .decode(value)
                .map_err(|_| "hls_key_base64_invalid".to_string())?;
            if bytes.len() != 16 {
                return Err("hls_key_length_invalid".into());
            }
            KeyOverrideKind::Base64
        }
        "url" => {
            if !(value.starts_with("http://") || value.starts_with("https://")) {
                return Err("hls_key_url_invalid".into());
            }
            KeyOverrideKind::Url
        }
        _ => return Err("hls_key_override_kind_invalid".into()),
    };
    let iv = iv
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| decode_hex_16(value, true))
        .transpose()?;
    Ok(KeyOverride {
        kind,
        value: value.to_string(),
        iv,
    })
}

pub fn override_key_bytes(value: &KeyOverride) -> Result<Option<[u8; 16]>, String> {
    match value.kind {
        KeyOverrideKind::Hex => decode_hex_16(&value.value, true).map(Some),
        KeyOverrideKind::Base64 => {
            let decoded = STANDARD
                .decode(&value.value)
                .map_err(|_| "hls_key_base64_invalid".to_string())?;
            decoded
                .try_into()
                .map(Some)
                .map_err(|_| "hls_key_length_invalid".to_string())
        }
        KeyOverrideKind::Url => Ok(None),
    }
}

pub fn parse_manifest_iv(value: Option<&str>, sequence: u64) -> Result<[u8; 16], String> {
    match value {
        Some(value) => decode_hex_16(value, false),
        None => {
            let mut iv = [0_u8; 16];
            iv[8..].copy_from_slice(&sequence.to_be_bytes());
            Ok(iv)
        }
    }
}

fn decode_hex_16(value: &str, strict: bool) -> Result<[u8; 16], String> {
    let value = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if value.is_empty()
        || value.len() > 32
        || value.len() % 2 != 0
        || strict && value.len() != 32
        || !value.chars().all(|character| character.is_ascii_hexdigit())
    {
        return Err("hls_iv_or_hex_invalid".into());
    }
    let mut result = [0_u8; 16];
    let start = 16 - value.len() / 2;
    for (index, chunk) in value.as_bytes().chunks(2).enumerate() {
        let text = std::str::from_utf8(chunk).map_err(|_| "hls_iv_or_hex_invalid")?;
        result[start + index] =
            u8::from_str_radix(text, 16).map_err(|_| "hls_iv_or_hex_invalid")?;
    }
    Ok(result)
}

pub fn decrypt_aes128(bytes: &[u8], key: &[u8; 16], iv: &[u8; 16]) -> Result<Vec<u8>, String> {
    Aes128CbcDec::new(key.into(), iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(bytes)
        .map_err(|_| "hls_aes128_decrypt_failed".to_string())
}

pub fn media_header_valid(bytes: &[u8]) -> bool {
    if bytes.len() >= 377 && bytes[0] == 0x47 && bytes[188] == 0x47 && bytes[376] == 0x47 {
        return true;
    }
    if bytes.len() >= 8 {
        let box_type = &bytes[4..8];
        if matches!(
            box_type,
            b"ftyp" | b"styp" | b"moof" | b"sidx" | b"moov" | b"mdat"
        ) {
            return true;
        }
    }
    bytes.starts_with(b"WEBVTT")
        || bytes.starts_with(b"ID3")
        || bytes.starts_with(b"OggS")
        || bytes.starts_with(&[0, 0, 0, 1])
        || bytes.starts_with(&[0, 0, 1])
        || bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] & 0xf0 == 0xf0
}

pub fn local_playlist(track: &TrackCheckpoint, track_dir: &Path) -> Result<PathBuf, String> {
    let playlist = track_dir.join("local.m3u8");
    let target_duration = track
        .segments
        .iter()
        .map(|segment| segment.duration)
        .fold(1.0_f64, f64::max)
        .ceil() as u64;
    let first_sequence = track
        .segments
        .first()
        .map(|segment| segment.sequence)
        .unwrap_or(0);
    let mut lines = vec![
        "#EXTM3U".to_string(),
        "#EXT-X-VERSION:7".to_string(),
        format!("#EXT-X-TARGETDURATION:{}", target_duration.max(1)),
        format!("#EXT-X-MEDIA-SEQUENCE:{first_sequence}"),
    ];
    let mut previous_map = None;
    for segment in &track.segments {
        if segment.discontinuity {
            lines.push("#EXT-X-DISCONTINUITY".into());
        }
        if segment.map_id != previous_map {
            if let Some(map_id) = &segment.map_id {
                let map = track
                    .maps
                    .iter()
                    .find(|item| &item.id == map_id)
                    .ok_or_else(|| "hls_map_missing".to_string())?;
                lines.push(format!(
                    "#EXT-X-MAP:URI=\"{}\"",
                    map.local_name.replace('\\', "/")
                ));
            }
            previous_map = segment.map_id.clone();
        }
        lines.push(format!("#EXTINF:{:.6},{}", segment.duration, segment.title));
        lines.push(segment.local_name.replace('\\', "/"));
    }
    lines.push("#EXT-X-ENDLIST".into());
    fs::write(&playlist, format!("{}\n", lines.join("\n"))).map_err(|error| error.to_string())?;
    Ok(playlist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ranges_keys_maps_and_sequences() {
        let manifest = PersistedManifest {
            base_url: "https://media.example/v/index.m3u8".into(),
            text: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\",IV=0x01\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"100@0\"\n#EXTINF:5,a\n#EXT-X-BYTERANGE:50@100\nvideo.mp4\n#EXTINF:5,b\n#EXT-X-BYTERANGE:50\nvideo.mp4\n#EXT-X-ENDLIST\n".into(),
        };
        let track = parse_media_playlist("video", "video", None, None, &manifest).unwrap();
        assert_eq!(track.segments.len(), 2);
        assert_eq!(track.segments[0].sequence, 20);
        assert_eq!(track.segments[1].byte_range.as_ref().unwrap().start, 150);
        assert_eq!(track.maps[0].byte_range.as_ref().unwrap().length, 100);
        assert_eq!(track.segments[0].key.as_ref().unwrap().method, "AES-128");
    }

    #[test]
    fn rejects_live_playlist() {
        let live = PersistedManifest {
            base_url: "https://media.example/live.m3u8".into(),
            text: "#EXTM3U\n#EXTINF:5,\na.ts\n".into(),
        };
        assert_eq!(
            parse_media_playlist("video", "video", None, None, &live).unwrap_err(),
            "hls_live_not_supported"
        );
    }

    #[test]
    fn encrypted_map_requires_explicit_iv() {
        let manifest = PersistedManifest {
            base_url: "https://media.example/v/index.m3u8".into(),
            text: "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:5,\nvideo.m4s\n#EXT-X-ENDLIST\n".into(),
        };
        assert_eq!(
            parse_media_playlist("video", "video", None, None, &manifest).unwrap_err(),
            "hls_map_iv_required"
        );
    }

    #[test]
    fn parses_override_and_default_iv() {
        let key = parse_key_override("hex", "00112233445566778899aabbccddeeff", None).unwrap();
        assert_eq!(override_key_bytes(&key).unwrap().unwrap()[0], 0);
        let iv = parse_manifest_iv(None, 258).unwrap();
        assert_eq!(&iv[14..], &[1, 2]);
        assert!(parse_key_override("base64", "bad", None).is_err());
    }

    #[test]
    fn checkpoint_round_trip_rejects_unknown_version() {
        let root =
            std::env::temp_dir().join(format!("streamfirefly-checkpoint-{}", std::process::id()));
        let path = root.join("checkpoint.json");
        let checkpoint = HlsCheckpoint {
            version: CHECKPOINT_VERSION,
            task_id: "round-trip".into(),
            plan: PersistedPlan {
                version: 2,
                duration: 5.0,
                container: "mp4".into(),
                video_manifest: PersistedManifest {
                    text: "#EXTM3U\n#EXTINF:5,\na.ts\n#EXT-X-ENDLIST\n".into(),
                    base_url: "https://media.example/index.m3u8".into(),
                },
                audio_manifest: None,
                subtitles: Vec::new(),
                live: false,
                poll_interval_seconds: None,
            },
            tracks: Vec::new(),
        };
        save_checkpoint(&path, &checkpoint).unwrap();
        let loaded = load_checkpoint(&path).unwrap();
        assert_eq!(loaded.task_id, "round-trip");
        let mut legacy = checkpoint.clone();
        legacy.version = 1;
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert_eq!(load_checkpoint(&path).unwrap().version, CHECKPOINT_VERSION);
        let mut invalid = checkpoint;
        invalid.version = CHECKPOINT_VERSION + 1;
        fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
        assert_eq!(
            load_checkpoint(&path).unwrap_err(),
            "hls_checkpoint_version_unsupported"
        );
        fs::rename(&path, path.with_extension("bak")).unwrap();
        assert_eq!(
            load_checkpoint(&path).unwrap_err(),
            "hls_checkpoint_version_unsupported"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn supports_ten_thousand_segments_without_unbounded_metadata() {
        let mut text = String::from("#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n");
        for index in 0..10_000 {
            text.push_str(&format!("#EXTINF:1,\n{index}.ts\n"));
        }
        text.push_str("#EXT-X-ENDLIST\n");
        let track = parse_media_playlist(
            "video",
            "video",
            None,
            None,
            &PersistedManifest {
                text,
                base_url: "https://media.example/v/index.m3u8".into(),
            },
        )
        .unwrap();
        assert_eq!(track.segments.len(), 10_000);
        assert!(serde_json::to_vec(&track).unwrap().len() < 5 * 1024 * 1024);
    }

    #[test]
    fn live_window_merges_by_sequence_url_and_range() {
        let manifest = |sequence: u64, names: &[&str], end_list: bool| PersistedManifest {
            base_url: "https://media.example/live/index.m3u8".into(),
            text: format!(
                "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:{sequence}\n{}{}",
                names
                    .iter()
                    .map(|name| format!("#EXTINF:4,\n{name}\n"))
                    .collect::<String>(),
                if end_list { "#EXT-X-ENDLIST\n" } else { "" }
            ),
        };
        let mut checkpoint = parse_live_media_playlist(
            "video",
            "video",
            None,
            None,
            &manifest(100, &["100.ts", "101.ts"], false),
        )
        .unwrap();
        let window = parse_live_media_playlist(
            "video",
            "video",
            None,
            None,
            &manifest(101, &["101.ts", "102.ts"], true),
        )
        .unwrap();
        assert_eq!(merge_live_window(&mut checkpoint, window).unwrap(), 1);
        assert_eq!(checkpoint.segments.len(), 3);
        assert_eq!(checkpoint.segments[2].sequence, 102);
        assert!(checkpoint.end_list);
        assert_eq!(checkpoint.duration, 12.0);
    }

    #[test]
    fn live_window_keeps_same_url_with_different_ranges() {
        let first = PersistedManifest {
            base_url: "https://media.example/live/index.m3u8".into(),
            text:
                "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\nmedia.mp4\n"
                    .into(),
        };
        let second = PersistedManifest {
            base_url: first.base_url.clone(),
            text:
                "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@10\nmedia.mp4\n"
                    .into(),
        };
        let mut checkpoint =
            parse_live_media_playlist("video", "video", None, None, &first).unwrap();
        let window = parse_live_media_playlist("video", "video", None, None, &second).unwrap();
        assert_eq!(merge_live_window(&mut checkpoint, window).unwrap(), 1);
        assert_eq!(checkpoint.segments.len(), 2);
    }

    #[test]
    fn live_window_resolves_implicit_range_after_previous_window() {
        let first = PersistedManifest {
            base_url: "https://media.example/live/index.m3u8".into(),
            text:
                "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\n#EXT-X-BYTERANGE:10@0\nmedia.mp4\n"
                    .into(),
        };
        let second = PersistedManifest {
            base_url: first.base_url.clone(),
            text: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:7\n#EXTINF:2,\n#EXT-X-BYTERANGE:10\nmedia.mp4\n#EXTINF:2,\n#EXT-X-BYTERANGE:10\nmedia.mp4\n"
                .into(),
        };
        let mut checkpoint =
            parse_live_media_playlist("video", "video", None, None, &first).unwrap();
        let window = parse_live_media_playlist_after(&checkpoint, &second).unwrap();
        assert_eq!(window.segments[0].byte_range.as_ref().unwrap().start, 0);
        assert_eq!(window.segments[1].byte_range.as_ref().unwrap().start, 10);
        merge_live_window(&mut checkpoint, window).unwrap();
        assert_eq!(checkpoint.segments.len(), 2);
    }

    #[test]
    fn live_window_preserves_rotated_keys() {
        let first = PersistedManifest {
            base_url: "https://media.example/live/index.m3u8".into(),
            text: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-KEY:METHOD=AES-128,URI=key-1.bin\n#EXTINF:2,\n1.ts\n".into(),
        };
        let second = PersistedManifest {
            base_url: first.base_url.clone(),
            text: "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:2\n#EXT-X-KEY:METHOD=AES-128,URI=key-2.bin\n#EXTINF:2,\n2.ts\n".into(),
        };
        let mut checkpoint =
            parse_live_media_playlist("video", "video", None, None, &first).unwrap();
        let window = parse_live_media_playlist_after(&checkpoint, &second).unwrap();
        merge_live_window(&mut checkpoint, window).unwrap();
        assert!(checkpoint.segments[0]
            .key
            .as_ref()
            .unwrap()
            .uri
            .as_deref()
            .unwrap()
            .ends_with("key-1.bin"));
        assert!(checkpoint.segments[1]
            .key
            .as_ref()
            .unwrap()
            .uri
            .as_deref()
            .unwrap()
            .ends_with("key-2.bin"));
    }

    #[test]
    fn identifies_unsupported_low_latency_parts_and_drm() {
        let ll = PersistedManifest {
            base_url: "https://media.example/live/index.m3u8".into(),
            text: "#EXTM3U\n#EXT-X-PART:DURATION=0.2,URI=part.m4s\n".into(),
        };
        assert_eq!(
            parse_live_media_playlist("video", "video", None, None, &ll).unwrap_err(),
            "hls_ll_part_unsupported"
        );
        let drm = PersistedManifest {
            base_url: ll.base_url,
            text: "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=key.bin,KEYFORMAT=\"com.apple.streamingkeydelivery\"\n#EXTINF:2,\n1.ts\n".into(),
        };
        assert_eq!(
            parse_live_media_playlist("video", "video", None, None, &drm).unwrap_err(),
            "hls_drm_unsupported"
        );
    }
}
