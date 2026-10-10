use crate::hls::save_checkpoint;
use crate::hls_plan::new_checkpoint;
use crate::model::Task;
use crate::model::TaskOutput;
use crate::paths::checkpoint_path_for_state;
use crate::paths::default_download_dir;
use crate::repository::is_sensitive_request_header;
use crate::repository::persist_tasks;
use crate::runtime::TaskRuntime;
use crate::scheduler::scheduler_full;
use crate::settings::download_threads;
use crate::task_input::allowed_request_headers;
use crate::task_input::extension_for;
use crate::task_input::hls_plan;
use crate::task_input::inline_manifest;
use crate::task_input::is_network_url;
use crate::task_input::safe_file_stem;
use crate::task_input::safe_title;
use crate::task_input::unique_output_path_with;
use crate::task_input::validate_dir;
use crate::task_input::with_site_subdirectory;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

pub(crate) fn create_task(store: &TaskRuntime, payload: &Value) -> Result<Task, &'static str> {
    let _creation = store.creation.lock().unwrap();
    if crate::runtime::host_exiting(store) {
        return Err("task_store_unavailable");
    }
    if store.repository.load_error.is_some() {
        return Err("task_store_unavailable");
    }
    if let Some(request_id) = payload["requestId"].as_str() {
        if request_id.is_empty() || request_id.len() > 128 {
            return Err("request_id_invalid");
        }
        if let Some(task) = store
            .repository
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.request_id.as_deref() == Some(request_id))
            .cloned()
        {
            return Ok(task);
        }
    }
    if payload["hlsPlan"]["version"].as_u64() == Some(3) && scheduler_full(store) {
        return Err("live_capacity_unavailable");
    }
    let dash_plan = crate::dash::parse_plan(payload)?;
    let inline_manifest = inline_manifest(payload)?;
    let hls_plan = hls_plan(payload)?;
    let hls_selection = hls_plan.is_some();
    if !hls_selection
        && (inline_manifest.is_some()
            || payload["url"]
                .as_str()
                .is_some_and(|url| url.to_ascii_lowercase().contains(".m3u8"))
            || payload["mime"]
                .as_str()
                .is_some_and(|mime| mime.contains("mpegurl")))
    {
        return Err("hls_plan_required");
    }
    if dash_plan.is_none()
        && (payload["mime"]
            .as_str()
            .is_some_and(|mime| mime.contains("dash+xml"))
            || payload["url"]
                .as_str()
                .is_some_and(|url| url.to_ascii_lowercase().contains(".mpd")))
    {
        return Err("dash_plan_required");
    }
    let url = payload["url"]
        .as_str()
        .filter(|url| is_network_url(url))
        .or_else(|| {
            inline_manifest
                .as_ref()
                .map(|manifest| manifest.base_url.as_str())
        })
        .or_else(|| {
            hls_plan
                .as_ref()
                .map(|plan| plan.video_manifest.base_url.as_str())
        })
        .ok_or("invalid_url")?
        .to_string();
    let title = safe_title(
        payload["title"]
            .as_str()
            .unwrap_or("streamfirefly-download"),
    );
    let dir = match payload["saveDir"].as_str() {
        Some(value) if !value.trim().is_empty() => validate_dir(value)?,
        _ => {
            let dir = default_download_dir();
            fs::create_dir_all(&dir).map_err(|_| "path_not_writable")?;
            dir
        }
    };
    let dir = with_site_subdirectory(dir, payload)?;
    let id = Uuid::new_v4().to_string();
    let ext = hls_plan
        .as_ref()
        .map(|value| value.container.clone())
        .or_else(|| dash_plan.as_ref().map(|plan| plan.container.clone()))
        .unwrap_or_else(|| extension_for(payload));
    let custom_name = match payload["fileName"].as_str() {
        Some(raw) => safe_file_stem(raw).ok_or("invalid_file_name")?,
        None => String::new(),
    };
    let mut tasks = store.repository.tasks.lock().unwrap();
    let mut reserved_paths: Vec<PathBuf> = Vec::new();
    let output = if payload["fileName"].is_string() {
        unique_output_path_with(&dir, &custom_name, &ext, &tasks, &reserved_paths)
    } else {
        unique_output_path_with(
            &dir,
            &format!("{}-{}", title, &id[..8]),
            &ext,
            &tasks,
            &reserved_paths,
        )
    };
    reserved_paths.push(output.clone());
    let display_title = if custom_name.is_empty() {
        title
    } else {
        custom_name
    };
    let request_headers = allowed_request_headers(payload);
    let requires_authorization = request_headers
        .keys()
        .any(|name| is_sensitive_request_header(name));
    let hls_plan_version = hls_plan.as_ref().map(|plan| plan.version).unwrap_or(0);
    let requires_key_override = hls_plan
        .as_ref()
        .is_some_and(|plan| plan.key_override.is_some());
    let mut reserved_sidecars = HashSet::new();
    let outputs = std::iter::once(TaskOutput {
        kind: "media".into(),
        language: None,
        label: None,
        path: Some(output.to_string_lossy().into()),
        state: "queued".into(),
        error: None,
    })
    .chain(
        hls_plan
            .as_ref()
            .into_iter()
            .flat_map(|plan| plan.subtitles.iter())
            .enumerate()
            .map(|(index, subtitle)| {
                let base_language = subtitle
                    .language
                    .clone()
                    .unwrap_or_else(|| format!("subtitle-{}", index + 1));
                let mut language = base_language.clone();
                let mut suffix = 2;
                while !reserved_sidecars.insert(format!(
                    "{}.{}",
                    language.to_ascii_lowercase(),
                    subtitle.extension
                )) {
                    language = format!("{base_language}-{suffix}");
                    suffix += 1;
                }
                let subtitle_stem = format!(
                    "{}.{}",
                    output.file_stem().unwrap_or_default().to_string_lossy(),
                    language
                );
                let subtitle_path = unique_output_path_with(
                    &dir,
                    &subtitle_stem,
                    &subtitle.extension,
                    &tasks,
                    &reserved_paths,
                );
                reserved_paths.push(subtitle_path.clone());
                TaskOutput {
                    kind: "subtitle".into(),
                    language: subtitle.language.clone(),
                    label: subtitle.label.clone(),
                    path: Some(subtitle_path.to_string_lossy().into()),
                    state: "queued".into(),
                    error: None,
                }
            }),
    )
    .collect();
    let task = Task {
        revision: 1,
        request_id: payload["requestId"].as_str().map(str::to_owned),
        id,
        url,
        title: display_title,
        state: "queued".into(),
        phase: "queued".into(),
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: None,
        speed_bytes_per_second: 0,
        eta_seconds: None,
        attempt: 1,
        message: Some("等待下载".into()),
        output: Some(output.to_string_lossy().into()),
        error: None,
        mime: payload["mime"].as_str().map(str::to_string),
        referer: payload["referer"].as_str().map(str::to_string),
        download_threads: download_threads(payload),
        request_headers,
        active_connections: 0,
        segments_completed: 0,
        segments_total: 0,
        source_context_id: payload["sourceContextId"].as_str().map(str::to_string),
        outputs,
        hls_selection,
        dash_selection: dash_plan.is_some(),
        dash_plan,
        hls_plan_version,
        failed_segments: 0,
        retry_count: 0,
        checkpoint_state: (hls_plan_version >= 2).then(|| "preparing".into()),
        resume_requirement: None,
        requires_authorization,
        requires_key_override,
        live_recording: hls_plan_version == 3,
        recorded_duration: 0.0,
        last_media_sequence: None,
        source_candidate_id: payload["candidateId"].as_str().map(str::to_string),
        inline_manifest,
        hls_plan,
        network: store.network.lock().unwrap().clone(),
    };
    if let Some(plan) = &task.hls_plan {
        let checkpoint = new_checkpoint(&task.id, plan).map_err(|_| "hls_checkpoint_invalid")?;
        save_checkpoint(
            &checkpoint_path_for_state(&store.repository.path, &task.id),
            &checkpoint,
        )
        .map_err(|_| "task_store_write_failed")?;
    }
    tasks.push(task.clone());
    if persist_tasks(&store.repository, &tasks).is_err() {
        tasks.retain(|current| current.id != task.id);
        return Err("task_store_write_failed");
    }
    Ok(task)
}
