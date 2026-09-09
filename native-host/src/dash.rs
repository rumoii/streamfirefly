use crate::segments::ByteRange;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DashResource {
    pub(crate) url: String,
    pub(crate) range: Option<ByteRange>,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DashSegment {
    #[serde(flatten)]
    pub(crate) resource: DashResource,
    pub(crate) duration: f64,
    pub(crate) time: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct DashTrack {
    pub(crate) id: String,
    pub(crate) kind: String,
    pub(crate) codecs: String,
    pub(crate) initialization: Option<DashResource>,
    pub(crate) segments: Vec<DashSegment>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashPlan {
    pub(crate) version: u8,
    pub(crate) base_url: String,
    pub(crate) duration: f64,
    pub(crate) container: String,
    pub(crate) tracks: Vec<DashTrack>,
}

fn validate_url(value: &str) -> Result<(), &'static str> {
    let parsed = url::Url::parse(value).map_err(|_| "dash_url_invalid")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || value.len() > 8192
        || value.chars().any(char::is_control)
    {
        return Err("dash_url_invalid");
    }
    Ok(())
}

fn validate_resource(resource: &DashResource) -> Result<(), &'static str> {
    validate_url(&resource.url)?;
    if let Some(range) = &resource.range {
        if range.length == 0
            || range.start.checked_add(range.length).is_none()
            || range.start + range.length > 9_007_199_254_740_991
        {
            return Err("dash_range_invalid");
        }
    }
    Ok(())
}

pub(crate) fn parse_plan(payload: &Value) -> Result<Option<DashPlan>, &'static str> {
    let Some(value) = payload.get("dashPlan").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    if !payload["hlsPlan"].is_null() || !payload["inlineManifest"].is_null() {
        return Err("download_plan_conflict");
    }
    if value.to_string().len() > 8 * 1024 * 1024 {
        return Err("dash_plan_too_large");
    }
    let plan: DashPlan = serde_json::from_value(value.clone()).map_err(|_| "dash_plan_invalid")?;
    if plan.version != 1 {
        return Err("dash_plan_version_unsupported");
    }
    validate_url(&plan.base_url)?;
    if !plan.duration.is_finite()
        || plan.duration <= 0.0
        || !matches!(plan.container.as_str(), "mp4" | "mkv")
        || plan.tracks.is_empty()
        || plan.tracks.len() > 2
    {
        return Err("dash_plan_invalid");
    }
    let mut kinds = HashSet::new();
    let mut ids = HashSet::new();
    let mut count = 0;
    for track in &plan.tracks {
        if !matches!(track.kind.as_str(), "audio" | "video")
            || !kinds.insert(&track.kind)
            || track.id.is_empty()
            || track.id.len() > 128
            || !ids.insert(&track.id)
            || track.segments.is_empty()
        {
            return Err("dash_track_invalid");
        }
        if plan.container == "mp4"
            && ![
                "avc1", "avc3", "hev1", "hvc1", "av01", "mp4a", "ac-3", "ec-3",
            ]
            .contains(&track.codecs.split('.').next().unwrap_or(""))
        {
            return Err("dash_container_incompatible");
        }
        if let Some(initialization) = &track.initialization {
            validate_resource(initialization)?;
        }
        count += track.segments.len();
        if count > 20000 {
            return Err("dash_segment_limit");
        }
        let mut end: Option<f64> = None;
        for segment in &track.segments {
            validate_resource(&segment.resource)?;
            if !segment.duration.is_finite()
                || segment.duration <= 0.0
                || !segment.time.is_finite()
                || !(segment.time + segment.duration).is_finite()
                || end.is_some_and(|previous| (previous - segment.time).abs() > 0.001)
            {
                return Err("dash_segment_time_invalid");
            }
            end = Some(segment.time + segment.duration);
        }
    }
    Ok(Some(plan))
}

#[cfg(test)]
mod tests {
    use super::parse_plan;
    use serde_json::{json, Value};

    fn payload() -> Value {
        json!({"dashPlan":{"version":1,"baseUrl":"https://example.test/source.mpd","duration":2,"container":"mp4","tracks":[{"id":"video-0","kind":"video","codecs":"avc1.64001f","initialization":{"url":"https://example.test/init.mp4","range":{"start":0,"length":99}},"segments":[{"url":"https://example.test/1.m4s","range":null,"duration":2,"time":0}]}]}})
    }

    #[test]
    fn validates_selected_plan_and_rejects_conflicting_protocols() {
        assert!(parse_plan(&payload()).unwrap().is_some());
        let mut value = payload();
        value["hlsPlan"] = json!({"version":2});
        assert_eq!(parse_plan(&value).unwrap_err(), "download_plan_conflict");
        value = payload();
        value["dashPlan"]["version"] = json!(2);
        assert_eq!(
            parse_plan(&value).unwrap_err(),
            "dash_plan_version_unsupported"
        );
    }

    #[test]
    fn validates_urls_ranges_and_container_before_execution() {
        for url in [
            "file:///secret",
            "https://user:password@example.test/1",
            "http://",
            "https://example.test/\nheader",
        ] {
            let mut value = payload();
            value["dashPlan"]["tracks"][0]["segments"][0]["url"] = json!(url);
            assert_eq!(parse_plan(&value).unwrap_err(), "dash_url_invalid");
        }
        let mut value = payload();
        value["dashPlan"]["tracks"][0]["initialization"]["range"]["length"] = json!(0);
        assert_eq!(parse_plan(&value).unwrap_err(), "dash_range_invalid");
        value = payload();
        value["dashPlan"]["tracks"][0]["codecs"] = json!("vp09");
        assert_eq!(
            parse_plan(&value).unwrap_err(),
            "dash_container_incompatible"
        );
        value["dashPlan"]["container"] = json!("mkv");
        assert!(parse_plan(&value).is_ok());
    }

    #[test]
    fn rejects_duplicate_tracks_and_discontinuous_segments() {
        let mut value = payload();
        let duplicate = value["dashPlan"]["tracks"][0].clone();
        value["dashPlan"]["tracks"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert_eq!(parse_plan(&value).unwrap_err(), "dash_track_invalid");
        value = payload();
        let mut next = value["dashPlan"]["tracks"][0]["segments"][0].clone();
        next["time"] = json!(3);
        value["dashPlan"]["tracks"][0]["segments"]
            .as_array_mut()
            .unwrap()
            .push(next);
        assert_eq!(parse_plan(&value).unwrap_err(), "dash_segment_time_invalid");
    }
}
