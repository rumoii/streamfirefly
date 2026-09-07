use super::*;

pub(super) fn run() -> io::Result<()> {
    let store = load_store(&state_path());
    let writer: Writer = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut input = io::stdin().lock();
    loop {
        let message = match read_message(&mut input) {
            Ok(value) => value,
            Err(_) => break,
        };
        let id = message["id"].clone();
        let message_type = message["type"].as_str().unwrap_or("");
        let response = match message_type {
            "host.info" => {
                json!({"version":1,"id":id,"ok":true,"protocolVersion":3,"supportedProtocolVersions":[3],"hostVersion":"0.9.0","capabilities":["inline-hls-v1","task-control-v1","task-pause-resume-v1","hls-selection-v1","hls-subtitle-sidecar-v1","task-output-group-v1","hls-segment-engine-v1","hls-checkpoint-v1","hls-aes128-v1","hls-key-override-v1","hls-reauthorize-v1","hls-live-engine-v1","task-queue-v1","task-idempotency-v1"]})
            }
            "task.find" => {
                if let Some(error) = &store.load_error {
                    json!({"version":1,"id":id,"ok":false,"error":error})
                } else {
                    let tasks = store.tasks.lock().unwrap();
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
            "task.control" => match task_control(&store, &writer, &message["payload"]) {
                Ok(task) => json!({"version":1,"id":id,"ok":true,"task":task}),
                Err(error) => json!({"version":1,"id":id,"ok":false,"error":error}),
            },
            "task.list" if store.load_error.is_some() => {
                json!({"version":1,"id":id,"ok":false,"error":store.load_error})
            }
            "task.list" => {
                let retry_save = store.runtime_error.lock().unwrap().is_some();
                if retry_save && save_store(&store).is_err() {
                    emit(
                        &writer,
                        json!({"version":1,"id":id,"ok":false,"error":"task_store_write_failed"}),
                    );
                    continue;
                }
                let tasks = store.tasks.lock().unwrap();
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
        if matches!(message_type, "host.info" | "task.list") {
            start_recovery_once(&store, &writer);
        }
    }
    Ok(())
}
