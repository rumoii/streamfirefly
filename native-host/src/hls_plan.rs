use crate::hls::parse_live_media_playlist;
use crate::hls::parse_media_playlist;
use crate::hls::HlsCheckpoint;
use crate::hls::PersistedManifest;
use crate::hls::PersistedPlan;
use crate::hls::PersistedSubtitlePlan;
use crate::hls::CHECKPOINT_VERSION;
use crate::model::HlsPlan;
use crate::model::HlsSubtitlePlan;
use crate::model::InlineManifest;

pub(crate) fn persisted_manifest(value: &InlineManifest) -> PersistedManifest {
    PersistedManifest {
        text: value.text.clone(),
        base_url: value.base_url.clone(),
    }
}

pub(crate) fn persisted_plan(value: &HlsPlan) -> PersistedPlan {
    PersistedPlan {
        version: value.version,
        duration: value.duration,
        container: value.container.clone(),
        video_manifest: persisted_manifest(&value.video_manifest),
        audio_manifest: value.audio_manifest.as_ref().map(persisted_manifest),
        subtitles: value
            .subtitles
            .iter()
            .map(|subtitle| PersistedSubtitlePlan {
                language: subtitle.language.clone(),
                label: subtitle.label.clone(),
                extension: subtitle.extension.clone(),
                manifest: persisted_manifest(&subtitle.manifest),
            })
            .collect(),
        live: value.live,
        poll_interval_seconds: value.poll_interval_seconds,
    }
}

pub(crate) fn runtime_plan_from_persisted(value: &PersistedPlan) -> HlsPlan {
    HlsPlan {
        version: value.version,
        duration: value.duration,
        container: value.container.clone(),
        video_manifest: InlineManifest {
            text: value.video_manifest.text.clone(),
            base_url: value.video_manifest.base_url.clone(),
        },
        audio_manifest: value
            .audio_manifest
            .as_ref()
            .map(|manifest| InlineManifest {
                text: manifest.text.clone(),
                base_url: manifest.base_url.clone(),
            }),
        subtitles: value
            .subtitles
            .iter()
            .map(|subtitle| HlsSubtitlePlan {
                language: subtitle.language.clone(),
                label: subtitle.label.clone(),
                extension: subtitle.extension.clone(),
                manifest: InlineManifest {
                    text: subtitle.manifest.text.clone(),
                    base_url: subtitle.manifest.base_url.clone(),
                },
            })
            .collect(),
        key_override: None,
        live: value.live,
        poll_interval_seconds: value.poll_interval_seconds,
    }
}

pub(crate) fn new_checkpoint(task_id: &str, plan: &HlsPlan) -> Result<HlsCheckpoint, String> {
    let persisted = persisted_plan(plan);
    let parse = if plan.live {
        parse_live_media_playlist
    } else {
        parse_media_playlist
    };
    let mut tracks = vec![parse(
        "video",
        "video",
        None,
        None,
        &persisted.video_manifest,
    )?];
    if let Some(audio) = &persisted.audio_manifest {
        tracks.push(parse(
            "audio",
            "audio",
            None,
            Some("外部音轨".into()),
            audio,
        )?);
    }
    for (index, subtitle) in persisted.subtitles.iter().enumerate() {
        tracks.push(parse(
            &format!("subtitle-{index}"),
            "subtitle",
            subtitle.language.clone(),
            subtitle.label.clone(),
            &subtitle.manifest,
        )?);
    }
    Ok(HlsCheckpoint {
        version: CHECKPOINT_VERSION,
        task_id: task_id.into(),
        plan: persisted,
        tracks,
    })
}
