use crate::hls::save_checkpoint;
use crate::hls_plan::new_checkpoint;
use crate::model::InlineManifest;
use crate::model::Task;
use crate::paths::checkpoint_path_for_state;
use crate::repository::sanitized_task;
use crate::repository::STORE_VERSION;
use crate::runtime::load_store;
use crate::segment_transfer::authorization_error;
use crate::segment_transfer::retry_after_seconds;
use crate::segment_transfer::retryable_error;
use crate::settings::DEFAULT_DOWNLOAD_THREADS;
use crate::task_control::delete_output;
use crate::task_control::delete_task_outputs;
use crate::task_control::ensure_restart_context;
use crate::task_control::task_output_paths;
use crate::task_creation::create_task;
use crate::task_input::extension_from_content_disposition;
use crate::task_input::extension_from_mime;
use crate::task_input::extension_from_url;
use crate::task_input::hls_plan;
use crate::task_input::inline_manifest;
use crate::task_input::prepare_task;
use crate::task_input::safe_file_stem;
use crate::task_input::safe_title;
use crate::task_input::unique_output_path;
use crate::task_input::validate_dir;
use crate::wire::read_message;
use crate::wire::write_message;
use serde_json::json;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

fn manifest_value(suffix: &str) -> Value {
    json!({
        "format":"hls",
        "text":format!("#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.test/{suffix}.ts\n#EXT-X-ENDLIST\n"),
        "baseUrl":"https://example.test/player"
    })
}

fn hls_payload(save_dir: Option<&Path>) -> Value {
    let mut payload = json!({
        "url":"https://example.test/master.m3u8",
        "title":"测试视频",
        "fileName":"测试视频",
        "mime":"application/vnd.apple.mpegurl",
        "sourceContextId":"source-context-a",
        "requestHeaders":{
            "cookie":"session=secret-cookie",
            "authorization":"Bearer secret-token",
            "referer":"https://example.test/page"
        },
        "hlsPlan":{
            "version":2,
            "duration":2.0,
            "container":"mkv",
            "videoManifest":manifest_value("video"),
            "audioManifest":manifest_value("audio"),
            "subtitles":[
                {"language":"zh-CN","label":"中文一","extension":"vtt","manifest":manifest_value("sub-1")},
                {"language":"zh-CN","label":"中文二","extension":"vtt","manifest":manifest_value("sub-2")}
            ]
        }
    });
    if let Some(dir) = save_dir {
        payload["saveDir"] = Value::String(dir.to_string_lossy().into_owned());
    }
    payload
}
#[test]
fn native_message_round_trip() {
    let value = json!({"version":1,"id":"a"});
    let mut data = Vec::new();
    write_message(&mut data, &value).unwrap();
    assert_eq!(read_message(&mut data.as_slice()).unwrap(), value);
}
#[test]
fn title_is_safe() {
    assert_eq!(safe_title("a:b"), "a_b");
    assert_eq!(safe_file_stem("  测试视频. "), Some("测试视频".into()));
    assert_eq!(safe_file_stem("CON"), Some("_CON".into()));
    assert_eq!(safe_file_stem("con.txt"), Some("_con.txt".into()));
    assert_eq!(safe_file_stem("..."), None);
}
#[test]
fn relative_path_is_rejected() {
    assert_eq!(validate_dir("downloads"), Err("path_must_be_absolute"));
}
#[test]
fn old_task_json_uses_progress_defaults() {
    let task: Task = serde_json::from_value(json!({
        "id":"old","url":"https://example.test/a.mp4","title":"old",
        "state":"succeeded","progress":100,"output":null,"error":null,"mime":"video/mp4"
    }))
    .unwrap();
    assert_eq!(task.phase, "");
    assert_eq!(task.downloaded_bytes, 0);
    assert_eq!(task.total_bytes, None);
    assert!(task.outputs.is_empty());
    assert!(task.source_context_id.is_none());
    assert!(!task.hls_selection);
}
#[test]
fn persisted_tasks_strip_credentials_but_keep_download_headers_in_memory() {
    let task: Task = serde_json::from_value(json!({
        "id":"credential-test","url":"https://example.test/a.mp4","title":"test",
        "state":"running","progress":10,"output":null,"error":null,"mime":"video/mp4",
        "request_headers":{
            "cookie":"session=secret-cookie",
            "authorization":"Bearer secret-token",
            "referer":"https://example.test/page",
            "origin":"https://example.test"
        }
    }))
    .unwrap();
    assert_eq!(task.request_headers["cookie"], "session=secret-cookie");
    let public_task = sanitized_task(&task);
    assert!(!public_task.request_headers.contains_key("cookie"));
    assert!(!public_task.request_headers.contains_key("authorization"));
    assert_eq!(
        public_task.request_headers["referer"],
        "https://example.test/page"
    );
    let serialized = serde_json::to_string(&public_task).unwrap();
    assert!(!serialized.contains("secret-cookie"));
    assert!(!serialized.contains("secret-token"));
}
#[test]
fn loading_old_store_scrubs_credentials_from_memory_and_disk() {
    let dir = std::env::temp_dir().join(format!("streamfirefly-store-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tasks.json");
    fs::write(
            &path,
            serde_json::to_vec_pretty(&json!({
                "version":STORE_VERSION,
                "tasks":[{
                    "id":"old-secret","url":"https://example.test/a.mp4","title":"old",
                    "state":"running","progress":10,"output":null,"error":null,"mime":"video/mp4",
                    "request_headers":{"cookie":"session=legacy-cookie-secret","referer":"https://example.test/page"}
                }]
            }))
            .unwrap(),
        )
        .unwrap();
    let store = load_store(&path);
    let tasks = store.repository.tasks.lock().unwrap();
    assert_eq!(tasks[0].state, "interrupted");
    assert!(!tasks[0].request_headers.contains_key("cookie"));
    assert_eq!(
        tasks[0].request_headers["referer"],
        "https://example.test/page"
    );
    assert_eq!(
        tasks[0].message.as_deref(),
        Some("登录凭据未持久化，请从页面重新发起下载")
    );
    drop(tasks);
    let persisted = fs::read_to_string(&path).unwrap();
    assert!(!persisted.contains("legacy-cookie-secret"));
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn file_path_is_rejected() {
    let path = std::env::temp_dir().join(format!("streamfirefly-file-{}", Uuid::new_v4()));
    fs::write(&path, b"test").unwrap();
    assert_eq!(
        validate_dir(path.to_string_lossy().as_ref()),
        Err("path_is_not_directory")
    );
    fs::remove_file(path).unwrap();
}
#[test]
fn file_extension_prefers_disposition_then_mime_then_url() {
    assert_eq!(
        extension_from_content_disposition("attachment; filename=movie.webm"),
        Some("webm".into())
    );
    assert_eq!(extension_from_mime("video/mp4"), Some("mp4"));
    assert_eq!(
        extension_from_url("https://example.test/video/sample.m4a?token=1"),
        Some("m4a".into())
    );
}
#[test]
fn task_prepare_uses_disposition_name_and_detected_extension() {
    let prepared = prepare_task(&json!({
        "url":"https://example.test/fallback.bin",
        "title":"页面标题",
        "mime":"video/mp4",
        "contentDisposition":"attachment; filename=movie.webm"
    }))
    .unwrap();
    assert_eq!(prepared["fileName"], "movie");
    assert_eq!(prepared["extension"], "webm");
}
#[test]
fn unique_output_adds_sequence_for_existing_and_reserved_names() {
    let dir = std::env::temp_dir().join(format!("streamfirefly-name-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("视频.mp4"), b"existing").unwrap();
    let tasks = vec![Task {
        id: "reserved".into(),
        revision: 1,
        request_id: None,
        url: "https://example.test/a.mp4".into(),
        title: "reserved".into(),
        state: "queued".into(),
        phase: "queued".into(),
        progress: 0,
        downloaded_bytes: 0,
        total_bytes: None,
        speed_bytes_per_second: 0,
        eta_seconds: None,
        attempt: 1,
        message: None,
        output: Some(dir.join("视频 (1).mp4").to_string_lossy().into()),
        error: None,
        mime: Some("video/mp4".into()),
        referer: None,
        download_threads: DEFAULT_DOWNLOAD_THREADS,
        request_headers: HashMap::new(),
        active_connections: 0,
        segments_completed: 0,
        segments_total: 0,
        source_context_id: None,
        outputs: Vec::new(),
        hls_selection: false,
        dash_selection: false,
        dash_plan: None,
        hls_plan_version: 0,
        failed_segments: 0,
        retry_count: 0,
        checkpoint_state: None,
        resume_requirement: None,
        requires_authorization: false,
        requires_key_override: false,
        live_recording: false,
        recorded_duration: 0.0,
        last_media_sequence: None,
        source_candidate_id: None,
        inline_manifest: Some(InlineManifest {
            text: "#EXTM3U\n".into(),
            base_url: "https://example.test/".into(),
        }),
        hls_plan: None,
        network: crate::network::NetworkConfig::default(),
    }];
    assert!(serde_json::to_value(&tasks[0])
        .unwrap()
        .get("inline_manifest")
        .is_none());
    assert_eq!(
        unique_output_path(&dir, "视频", "mp4", &tasks),
        dir.join("视频 (2).mp4")
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn inline_hls_prepare_validates_and_uses_mp4() {
    let prepared = prepare_task(&json!({
        "url":"blob:https://example.test/generated",
        "title":"内存视频",
        "inlineManifest": {
            "format":"hls",
            "text":"#EXTM3U\n#EXTINF:2,\nhttps://cdn.example.test/one.ts\n",
            "baseUrl":"https://example.test/player"
        }
    }))
    .unwrap();
    assert_eq!(prepared["fileName"], "内存视频");
    assert_eq!(prepared["extension"], "mp4");
}
#[test]
fn hls_plan_validates_version_duration_container_and_subtitle_limit() {
    let valid = hls_payload(None);
    let plan = hls_plan(&valid).unwrap().unwrap();
    assert_eq!(plan.container, "mkv");
    assert_eq!(plan.subtitles.len(), 2);

    for (field, value, expected) in [
        ("version", json!(4), "hls_plan_version_unsupported"),
        ("duration", json!(0), "hls_plan_invalid"),
        ("container", json!("avi"), "hls_plan_invalid"),
    ] {
        let mut invalid = valid.clone();
        invalid["hlsPlan"][field] = value;
        assert_eq!(hls_plan(&invalid).unwrap_err(), expected);
    }

    let mut live = valid.clone();
    live["hlsPlan"]["version"] = json!(3);
    live["hlsPlan"]["duration"] = json!(0);
    live["hlsPlan"]["pollIntervalSeconds"] = json!(2);
    let live = hls_plan(&live).unwrap().unwrap();
    assert!(live.live);
    assert_eq!(live.poll_interval_seconds, Some(2));

    let mut excessive = valid;
    excessive["hlsPlan"]["subtitles"] = Value::Array(
            (0..17)
                .map(|index| json!({"language":format!("s{index}"),"extension":"vtt","manifest":manifest_value("subtitle")}))
                .collect(),
        );
    assert_eq!(
        hls_plan(&excessive).unwrap_err(),
        "hls_plan_too_many_subtitles"
    );
}
#[test]
fn hls_plan_v2_accepts_valid_key_override_and_v1_rejects_it() {
    let mut payload = hls_payload(None);
    payload["hlsPlan"]["version"] = json!(2);
    payload["hlsPlan"]["keyOverride"] = json!({
        "kind":"hex",
        "value":"00112233445566778899aabbccddeeff",
        "iv":"00000000000000000000000000000001"
    });
    let plan = hls_plan(&payload).unwrap().unwrap();
    assert_eq!(plan.version, 2);
    assert!(plan.key_override.is_some());

    payload["hlsPlan"]["version"] = json!(1);
    assert_eq!(
        hls_plan(&payload).unwrap_err(),
        "hls_plan_version_unsupported"
    );

    payload["hlsPlan"]["version"] = json!(2);
    payload["hlsPlan"]["keyOverride"]["value"] = json!("bad");
    assert_eq!(hls_plan(&payload).unwrap_err(), "hls_key_override_invalid");
}
#[test]
fn hls_prepare_uses_selected_container_and_rejects_before_creating_save_dir() {
    let prepared = prepare_task(&hls_payload(None)).unwrap();
    assert_eq!(prepared["extension"], "mkv");

    let root = std::env::temp_dir().join(format!("streamfirefly-invalid-plan-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let save_dir = root.join("must-not-exist");
    let store = load_store(&root.join("tasks.json"));
    let mut invalid = hls_payload(Some(&save_dir));
    invalid["hlsPlan"]["duration"] = json!(0);
    assert_eq!(
        create_task(&store, &invalid).unwrap_err(),
        "hls_plan_invalid"
    );
    assert!(!save_dir.exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn hls_task_keeps_public_outputs_but_strips_runtime_plan_and_credentials() {
    let root = std::env::temp_dir().join(format!("streamfirefly-hls-task-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let store = load_store(&root.join("tasks.json"));
    let task = create_task(&store, &hls_payload(Some(&root))).unwrap();
    assert_eq!(task.outputs.len(), 3);
    assert_ne!(task.outputs[1].path, task.outputs[2].path);
    assert!(task.outputs[2].path.as_deref().unwrap().contains("zh-CN-2"));

    let public = sanitized_task(&task);
    assert_eq!(
        public.source_context_id.as_deref(),
        Some("source-context-a")
    );
    assert_eq!(public.outputs.len(), 3);
    assert!(public.hls_selection);
    assert!(public.hls_plan.is_none());
    assert!(!public.request_headers.contains_key("cookie"));
    assert!(!public.request_headers.contains_key("authorization"));
    assert_eq!(
        public.request_headers["referer"],
        "https://example.test/page"
    );
    let serialized = serde_json::to_string(&public).unwrap();
    assert!(!serialized.contains("secret-cookie"));
    assert!(!serialized.contains("secret-token"));
    assert!(!serialized.contains("videoManifest"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn queued_hls_task_persists_a_recoverable_plan_before_execution() {
    let root = std::env::temp_dir().join(format!("streamfirefly-hls-restart-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("tasks.json");
    let store = load_store(&path);
    let created = create_task(&store, &hls_payload(Some(&root))).unwrap();
    drop(store);
    let reloaded = load_store(&path);
    let task = reloaded
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|item| item.id == created.id)
        .unwrap()
        .clone();
    assert_eq!(task.state, "interrupted");
    assert!(task.hls_plan.is_none());
    assert!(task.hls_selection);
    assert_eq!(ensure_restart_context(&reloaded, &task), Ok(()));
    assert!(task
        .outputs
        .iter()
        .all(|output| output.state == "interrupted"));
    assert!(task.outputs.iter().any(|output| output.kind == "subtitle"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn restarted_hls_v2_task_exposes_reauthorization_only_with_checkpoint() {
    let root =
        std::env::temp_dir().join(format!("streamfirefly-hls-v2-restart-{}", Uuid::new_v4()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("tasks.json");
    let store = load_store(&path);
    let mut payload = hls_payload(Some(&root));
    payload["hlsPlan"]["version"] = json!(2);
    payload["candidateId"] = json!("candidate-a");
    let created = create_task(&store, &payload).unwrap();
    let checkpoint = new_checkpoint(&created.id, created.hls_plan.as_ref().unwrap()).unwrap();
    save_checkpoint(
        &checkpoint_path_for_state(&store.repository.path, &created.id),
        &checkpoint,
    )
    .unwrap();
    drop(store);

    let reloaded = load_store(&path);
    let task = reloaded
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|item| item.id == created.id)
        .unwrap()
        .clone();
    assert_eq!(task.state, "interrupted");
    assert_eq!(task.checkpoint_state.as_deref(), Some("recoverable"));
    assert_eq!(
        task.resume_requirement.as_deref(),
        Some("authorization_required")
    );
    assert_eq!(task.source_candidate_id.as_deref(), Some("candidate-a"));
    assert_eq!(ensure_restart_context(&reloaded, &task), Ok(()));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn retry_and_authorization_classification_is_bounded() {
    assert!(retryable_error("http_status_429:retry_after=90"));
    assert!(retryable_error("http_status_503"));
    assert!(!retryable_error("http_status_404"));
    assert!(authorization_error("http_status_401"));
    assert!(authorization_error("http_status_403:retry_after=1"));
    assert_eq!(
        retry_after_seconds("http_status_429:retry_after=90"),
        Some(30)
    );
    assert_eq!(retry_after_seconds("http_status_500"), None);
}
#[test]
fn inline_hls_rejects_local_file_uris() {
    let result = inline_manifest(&json!({
        "inlineManifest": {
            "format":"hls",
            "text":"#EXTM3U\n#EXTINF:2,\nfile:///C:/secret.txt\n",
            "baseUrl":"https://example.test/player"
        }
    }));
    assert_eq!(result.unwrap_err(), "inline_manifest_unsafe_uri");
}
#[test]
fn delete_output_rejects_directories_and_accepts_missing_files() {
    let dir = std::env::temp_dir().join(format!("streamfirefly-delete-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    assert_eq!(
        delete_output(dir.to_string_lossy().as_ref()),
        Err("file_delete_unsafe")
    );
    assert_eq!(
        delete_output(dir.join("missing.mp4").to_string_lossy().as_ref()),
        Ok(false)
    );
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn delete_task_outputs_removes_media_and_all_subtitle_files_once() {
    let dir = std::env::temp_dir().join(format!("streamfirefly-delete-group-{}", Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    let media = dir.join("video.mp4");
    let subtitle = dir.join("video.zh-CN.vtt");
    fs::write(&media, b"media").unwrap();
    fs::write(&subtitle, b"subtitle").unwrap();
    let task: Task = serde_json::from_value(json!({
            "id":"delete-group","url":"https://example.test/a.m3u8","title":"delete-group",
            "state":"partial","progress":100,"output":media,"error":"subtitle_output_failed","mime":"application/vnd.apple.mpegurl",
            "outputs":[
                {"kind":"media","path":media,"state":"succeeded"},
                {"kind":"subtitle","language":"zh-CN","path":subtitle,"state":"failed"}
            ]
        })).unwrap();
    assert_eq!(task_output_paths(&task).len(), 2);
    assert_eq!(delete_task_outputs(&task), Ok(true));
    assert!(!media.exists());
    assert!(!subtitle.exists());
    fs::remove_dir_all(dir).unwrap();
}
