use crate::hls::parse_key_override;
use crate::model::HlsPlan;
use crate::model::HlsSubtitlePlan;
use crate::model::InlineManifest;
use crate::model::Task;
use crate::settings::INLINE_MANIFEST_MAX_BYTES;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::path::Path;
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) fn safe_title(value: &str) -> String {
    safe_file_stem(value).unwrap_or_else(|| "streamfirefly-download".into())
}

pub(crate) fn safe_file_stem(value: &str) -> Option<String> {
    let value: String = value
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .take(100)
        .collect();
    let value = value.trim().trim_end_matches([' ', '.']).to_string();
    if value.is_empty() {
        return None;
    }
    let upper = value.to_ascii_uppercase();
    let device = upper.split('.').next().unwrap_or(&upper);
    let reserved = matches!(device, "CON" | "PRN" | "AUX" | "NUL")
        || (device.len() == 4
            && (device.starts_with("COM") || device.starts_with("LPT"))
            && device.as_bytes()[3].is_ascii_digit()
            && device.as_bytes()[3] != b'0');
    Some(if reserved { format!("_{value}") } else { value })
}

pub(crate) fn extension_from_mime(mime: &str) -> Option<&'static str> {
    match mime.to_ascii_lowercase().as_str() {
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/mpeg" => Some("mpeg"),
        "audio/mpeg" | "audio/mp3" => Some("mp3"),
        "audio/mp4" | "audio/x-m4a" => Some("m4a"),
        "audio/wav" | "audio/x-wav" => Some("wav"),
        "audio/aac" => Some("aac"),
        "audio/ogg" => Some("ogg"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

pub(crate) fn extension_from_url(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?.rsplit('/').next()?;
    let (_, ext) = path.rsplit_once('.')?;
    let ext = ext.trim().to_ascii_lowercase();
    ((1..=8).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())).then_some(ext)
}

pub(crate) fn filename_from_content_disposition(value: &str) -> Option<String> {
    value.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("filename")
            .then(|| value.trim().trim_matches('"').to_string())
    })
}

pub(crate) fn extension_from_content_disposition(value: &str) -> Option<String> {
    extension_from_url(&filename_from_content_disposition(value)?)
}

pub(crate) fn is_network_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

pub(crate) fn validate_manifest_uri(value: &str) -> Result<(), &'static str> {
    is_network_url(value.trim())
        .then_some(())
        .ok_or("inline_manifest_unsafe_uri")
}

pub(crate) fn validate_manifest_line(line: &str) -> Result<(), &'static str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    if !trimmed.starts_with('#') {
        return validate_manifest_uri(trimmed);
    }
    let lower = trimmed.to_ascii_lowercase();
    let mut offset = 0;
    while let Some(relative) = lower[offset..].find("uri=") {
        let value_start = offset + relative + 4;
        let quote = trimmed.as_bytes().get(value_start).copied();
        if !matches!(quote, Some(b'\"' | b'\'')) {
            return Err("inline_manifest_unsafe_uri");
        }
        let quote = quote.unwrap();
        let rest = &trimmed.as_bytes()[value_start + 1..];
        let Some(length) = rest.iter().position(|value| *value == quote) else {
            return Err("inline_manifest_invalid");
        };
        let value_end = value_start + 1 + length;
        validate_manifest_uri(&trimmed[value_start + 1..value_end])?;
        offset = value_end + 1;
    }
    Ok(())
}

pub(crate) fn parse_inline_manifest_value(value: &Value) -> Result<InlineManifest, &'static str> {
    if value["format"].as_str() != Some("hls") {
        return Err("inline_manifest_invalid");
    }
    let text = value["text"].as_str().ok_or("inline_manifest_invalid")?;
    if text.is_empty() || text.len() > INLINE_MANIFEST_MAX_BYTES {
        return Err("inline_manifest_too_large");
    }
    if text.lines().next().map(str::trim) != Some("#EXTM3U") || text.contains('\0') {
        return Err("inline_manifest_invalid");
    }
    let base_url = value["baseUrl"]
        .as_str()
        .filter(|url| is_network_url(url))
        .ok_or("inline_manifest_invalid")?;
    for line in text.lines() {
        validate_manifest_line(line)?;
    }
    Ok(InlineManifest {
        text: text.into(),
        base_url: base_url.into(),
    })
}

pub(crate) fn inline_manifest(payload: &Value) -> Result<Option<InlineManifest>, &'static str> {
    let Some(value) = payload
        .get("inlineManifest")
        .filter(|value| !value.is_null())
    else {
        return Ok(None);
    };
    parse_inline_manifest_value(value).map(Some)
}

pub(crate) fn hls_plan(payload: &Value) -> Result<Option<HlsPlan>, &'static str> {
    let Some(value) = payload.get("hlsPlan").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let version = value["version"]
        .as_u64()
        .filter(|version| matches!(*version, 2 | 3))
        .ok_or("hls_plan_version_unsupported")? as u8;
    let live = version == 3;
    let duration = value["duration"]
        .as_f64()
        .filter(|value| value.is_finite() && (*value > 0.0 || live && *value >= 0.0))
        .ok_or("hls_plan_invalid")?;
    let poll_interval_seconds = value
        .get("pollIntervalSeconds")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 30));
    let container = value["container"]
        .as_str()
        .filter(|value| matches!(*value, "mp4" | "mkv"))
        .ok_or("hls_plan_invalid")?
        .to_string();
    let video_manifest = parse_inline_manifest_value(&value["videoManifest"])?;
    let audio_manifest = value
        .get("audioManifest")
        .filter(|item| !item.is_null())
        .map(parse_inline_manifest_value)
        .transpose()?;
    let subtitles = value["subtitles"]
        .as_array()
        .ok_or("hls_plan_invalid")?
        .iter()
        .map(|item| {
            let extension = item["extension"]
                .as_str()
                .filter(|value| matches!(*value, "vtt" | "srt" | "ass"))
                .ok_or("hls_plan_invalid")?
                .to_string();
            Ok(HlsSubtitlePlan {
                language: item["language"].as_str().and_then(safe_file_stem),
                label: item["label"]
                    .as_str()
                    .map(|value| value.chars().take(80).collect()),
                extension,
                manifest: parse_inline_manifest_value(&item["manifest"])?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    if subtitles.len() > 16 {
        return Err("hls_plan_too_many_subtitles");
    }
    let key_override = value
        .get("keyOverride")
        .filter(|item| !item.is_null())
        .map(|item| {
            parse_key_override(
                item["kind"].as_str().unwrap_or(""),
                item["value"].as_str().unwrap_or(""),
                item["iv"].as_str(),
            )
            .map_err(|_| "hls_key_override_invalid")
        })
        .transpose()?;
    Ok(Some(HlsPlan {
        version,
        duration,
        container,
        video_manifest,
        audio_manifest,
        subtitles,
        key_override,
        live,
        poll_interval_seconds,
    }))
}

pub(crate) fn extension_for(payload: &Value) -> String {
    let url = payload["url"].as_str().unwrap_or("");
    let mime = payload["mime"].as_str().unwrap_or("");
    if payload
        .get("inlineManifest")
        .is_some_and(|value| !value.is_null())
        || mime.contains("mpegurl")
        || mime.contains("dash+xml")
        || url.contains(".m3u8")
        || url.contains(".mpd")
    {
        "mp4".into()
    } else if let Some(ext) = payload["contentDisposition"]
        .as_str()
        .and_then(extension_from_content_disposition)
    {
        ext
    } else if let Some(ext) = extension_from_mime(mime) {
        ext.into()
    } else {
        extension_from_url(url).unwrap_or_else(|| "download".into())
    }
}

pub(crate) fn recommended_file_stem(payload: &Value) -> String {
    let disposition = payload["contentDisposition"]
        .as_str()
        .and_then(filename_from_content_disposition)
        .and_then(|name| {
            Path::new(&name)
                .file_stem()
                .map(|value| value.to_string_lossy().into())
        });
    let url_name = payload["url"]
        .as_str()
        .and_then(|url| url.split(['?', '#']).next())
        .and_then(|url| url.rsplit('/').next())
        .and_then(|name| {
            Path::new(name)
                .file_stem()
                .map(|value| value.to_string_lossy().into())
        });
    let title = payload["title"].as_str().map(str::to_string);
    disposition
        .or_else(|| {
            payload
                .get("inlineManifest")
                .filter(|value| !value.is_null())
                .and(title.clone())
        })
        .or(url_name)
        .or(title)
        .and_then(|name| safe_file_stem(&name))
        .unwrap_or_else(|| "streamfirefly-download".into())
}

pub(crate) fn prepare_task(payload: &Value) -> Result<Value, &'static str> {
    let dash = crate::dash::parse_plan(payload)?;
    let manifest = inline_manifest(payload)?;
    let plan = hls_plan(payload)?;
    if manifest.is_none() && plan.is_none() {
        payload["url"]
            .as_str()
            .filter(|url| is_network_url(url))
            .ok_or("invalid_url")?;
    }
    let extension = plan
        .as_ref()
        .map(|value| value.container.clone())
        .or_else(|| dash.as_ref().map(|plan| plan.container.clone()))
        .unwrap_or_else(|| extension_for(payload));
    Ok(json!({"fileName": recommended_file_stem(payload), "extension": extension}))
}

pub(crate) fn unique_output_path(dir: &Path, stem: &str, ext: &str, tasks: &[Task]) -> PathBuf {
    for index in 0..10_000 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let candidate = dir.join(format!("{stem}{suffix}.{ext}"));
        let occupied = tasks
            .iter()
            .any(|task| task.output.as_deref().map(Path::new) == Some(candidate.as_path()));
        if !candidate.exists() && !occupied {
            return candidate;
        }
    }
    dir.join(format!("{}-{}.{}", stem, Uuid::new_v4(), ext))
}

pub(crate) fn validate_dir(value: &str) -> Result<PathBuf, &'static str> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("path_empty");
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("path_must_be_absolute");
    }
    if path.exists() {
        if !path.is_dir() {
            return Err("path_is_not_directory");
        }
    } else if fs::create_dir_all(&path).is_err() {
        return Err("path_not_writable");
    }
    let probe = path.join(format!(".streamfirefly-write-{}.tmp", Uuid::new_v4()));
    if OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .is_err()
    {
        return Err("path_not_writable");
    }
    let _ = fs::remove_file(probe);
    Ok(path)
}

pub(crate) fn allowed_request_headers(payload: &Value) -> HashMap<String, String> {
    let allowed = ["referer", "origin", "authorization", "cookie", "user-agent"];
    let mut headers = HashMap::new();
    if let Some(values) = payload["requestHeaders"].as_object() {
        for (name, value) in values {
            let key = name.to_ascii_lowercase();
            if allowed.contains(&key.as_str()) {
                if let Some(value) = value.as_str().filter(|value| !value.is_empty()) {
                    headers.insert(key, value.to_string());
                }
            }
        }
    }
    if !headers.contains_key("referer") {
        if let Some(referer) = payload["referer"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            headers.insert("referer".into(), referer.into());
        }
    }
    headers
}
