use crate::paths::approved_programs_path;
use crate::paths::state_path;
use crate::recovery::network_ready;
use crate::recovery::request_recovery;
use crate::repository::sanitized_task;
use crate::repository::sanitized_tasks;
use crate::repository::save_store;
use crate::runtime::load_store;
use crate::runtime::TaskRuntime;
use crate::scheduler::start_download;
use crate::task_control::delete_task;
use crate::task_control::reveal_task_output;
use crate::task_control::task_control;
use crate::task_creation::create_task;
use crate::task_input::prepare_task;
use crate::task_input::validate_dir;
use crate::wire::emit;
use crate::wire::read_message;
use crate::wire::Writer;
use serde_json::json;
use std::io;
use std::sync::Arc;
use std::sync::Mutex;
use crate::lock::LockExt;

pub(crate) fn run() -> io::Result<()> {
    let launcher = crate::integrations::ProgramLauncher::new(approved_programs_path());
    let captures = crate::capture::CaptureManager::new(
        crate::paths::state_path()
            .parent()
            .unwrap()
            .join("captures"),
    );
    let store = load_store(&state_path());
    let writer: Writer = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut input = io::stdin().lock();
    loop {
        let message = match read_message(&mut input) {
            Ok(value) => value,
            // A single malformed message must not kill the host or its downloads;
            // only a real EOF or a desynced stream shuts everything down.
            Err(crate::wire::WireError::Invalid) => {
                emit(
                    &writer,
                    json!({"version":1,"id":null,"ok":false,"error":"invalid_message"}),
                );
                continue;
            }
            Err(crate::wire::WireError::Eof) => break,
            Err(crate::wire::WireError::Fatal(error)) => {
                eprintln!("streamfirefly native message stream desynced: {error}");
                break;
            }
        };
        let id = message["id"].clone();
        let message_type = message["type"].as_str().unwrap_or("");
        let response = match message_type {
            "capture.open" | "capture.close" | "capture.abort" => {
                let result = if message_type == "capture.open" {
                    captures.open(&message["payload"])
                } else {
                    captures.stop(&message["payload"], message_type == "capture.abort")
                };
                match result {
                    Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                    Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
                }
            }
            "capture.list" => json!({"version":1,"id":id,"ok":true,"value":captures.list()}),
            "capture.diagnostics" => json!({"version":1,"id":id,"ok":true,"value":captures.diagnostics(&message["payload"])}),
            "capture.reveal" => match captures.reveal(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "capture.delete" => match captures.delete(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "integration.test" | "integration.invoke" => {
                let result = if message_type == "integration.test" {
                    launcher.test(&message["payload"])
                } else {
                    launcher.invoke(&message["payload"])
                };
                match result {
                    Ok(receipt) => json!({"version":1,"id":id,"ok":true,"receipt":receipt}),
                    Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
                }
            }
            "integration.approve" => match launcher.approve(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "integration.revoke" => match launcher.revoke(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "integration.approved" => match launcher.approval(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "host.info" => {
                json!({"version":1,"id":id,"ok":true,"protocolVersion":3,"supportedProtocolVersions":[3],"hostVersion":env!("CARGO_PKG_VERSION"),"capabilities":["dash-selection-v1","inline-hls-v1","task-control-v1","task-pause-resume-v1","hls-selection-v1","hls-subtitle-sidecar-v1","task-output-group-v1","hls-segment-engine-v1","hls-checkpoint-v1","hls-aes128-v1","hls-key-override-v1","hls-reauthorize-v1","hls-live-engine-v1","task-queue-v1","task-idempotency-v1", "integration-program-v1", "capture-stream-v1", "capture-diagnostics-v1", "capture-reveal-v1", "task-reveal-v1", "network-policy-v1"]})
            }
            "network.configure" => {
                match crate::network::NetworkConfig::from_payload(&message["payload"]) {
                    Ok(config) => {
                        *store.network.lock_or_recover() = config.clone();
                        for task in store.repository.tasks.lock_or_recover().iter_mut() {
                            task.network = config.clone();
                        }
                        network_ready(&store, &writer);
                        json!({"version":1,"id":id,"ok":true})
                    }
                    Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
                }
            }
            "task.find" => {
                if let Some(error) = &store.repository.load_error {
                    json!({"version":1,"id":id,"ok":false,"error":error})
                } else {
                    let tasks = store.repository.tasks.lock_or_recover();
                    let task = message["payload"]["requestId"]
                        .as_str()
                        .and_then(|request_id| {
                            tasks
                                .iter()
                                .find(|task| task.request_id.as_deref() == Some(request_id))
                        })
                        .map(sanitized_task);
                    json!({"version":1,"id":id,"ok":true,"task":task})
                }
            }
            "task.create"
                if message["payload"]["requestId"]
                    .as_str()
                    .is_none_or(|value| value.is_empty()) =>
            {
                json!({"version":1,"id":id,"ok":false,"error":"request_id_required"})
            }
            "task.create" => match create_task(&store, &message["payload"]) {
                Ok(task) => {
                    if task.state == "queued" {
                        start_download(store.clone(), writer.clone(), task.clone());
                    }
                    json!({"version":1,"id":id,"ok":true,"task":sanitized_task(&task)})
                }
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.prepare" => match prepare_task(&message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"payload":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.delete" => match delete_task(&store, &writer, &message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"payload":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.reveal" => match reveal_task_output(&store, &message["payload"]) {
                Ok(value) => json!({"version":1,"id":id,"ok":true,"value":value}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.control" => match task_control(&store, &writer, &message["payload"]) {
                Ok(task) => json!({"version":1,"id":id,"ok":true,"task":task}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.list" if store.repository.load_error.is_some() => {
                json!({"version":1,"id":id,"ok":false,"error":store.repository.load_error})
            }
            "task.list" => {
                let retry_save = store.repository.runtime_error.lock_or_recover().is_some();
                if retry_save && save_store(&store.repository).is_err() {
                    emit(
                        &writer,
                        json!({"version":1,"id":id,"ok":false,"error":"task_store_write_failed"}),
                    );
                    continue;
                }
                let tasks = store.repository.tasks.lock_or_recover();
                json!({"version":1,"id":id,"ok":true,"tasks":sanitized_tasks(&tasks)})
            }
            "path.validate" => match message["payload"]["path"]
                .as_str()
                .ok_or("path_empty")
                .and_then(validate_dir)
            {
                Ok(path) => json!({"version":1,"id":id,"ok":true,"path":path.to_string_lossy()}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            _ => json!({"version":1,"id":id,"ok":false,"error":"unsupported_message"}),
        };
        emit(&writer, response);
        if message_type == "task.list" {
            request_recovery(&store, &writer);
        }
    }
    shutdown_host(&store, &captures)
}

/// Ends every download child so no orphaned writer outlives the host.
pub(crate) fn shutdown_downloads(store: &TaskRuntime) -> Result<(), String> {
    crate::processes::shutdown_processes(store)
}

/// Normal EOF shutdown: freeze task scheduling and retries first, end the download
/// children, then stop capture sessions and wait for their workers. The task map stays
/// locked until exit so an output move and its saved state land together or not at all.
/// Any cleanup failure exits non-zero instead of pretending success.
fn shutdown_host(store: &TaskRuntime, captures: &crate::capture::CaptureManager) -> ! {
    store.exiting.store(true, std::sync::atomic::Ordering::SeqCst);
    let download_result = shutdown_downloads(store);
    let capture_result = captures.shutdown();
    let _tasks = store
        .repository
        .tasks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match (download_result, capture_result) {
        (Ok(()), Ok(())) => std::process::exit(0),
        (download, capture) => {
            eprintln!("streamfirefly shutdown incomplete: download={download:?}, capture={capture:?}");
            std::process::exit(1)
        }
    }
}
