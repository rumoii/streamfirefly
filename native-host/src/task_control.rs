use crate::hls::load_checkpoint;
use crate::hls::parse_key_override;
use crate::hls_plan::runtime_plan_from_persisted;
use crate::model::Task;
use crate::paths::checkpoint_available;
use crate::paths::checkpoint_path_for_state;
use crate::paths::task_work_root_for_state;
use crate::processes::clear_cancellation;
use crate::processes::clear_pause;
use crate::processes::clear_stop;
use crate::processes::mark_stopped;
use crate::processes::stop_process;
use crate::processes::wait_for_state;
use crate::repository::is_sensitive_request_header;
use crate::repository::persist_tasks;
use crate::repository::sanitized_task;
use crate::repository::save_store;
use crate::runtime::TaskRuntime;
use crate::scheduler::remove_pending;
use crate::scheduler::scheduler_active;
use crate::scheduler::scheduler_full;
use crate::scheduler::start_download;
use crate::task_input::allowed_request_headers;
use crate::task_state::update;
use crate::wire::emit;
use crate::wire::Writer;
use serde_json::json;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;
use std::thread;
use std::time::Duration;
use std::time::Instant;

pub(crate) fn ensure_restart_context(store: &TaskRuntime, task: &Task) -> Result<(), &'static str> {
    if task.dash_selection && task.dash_plan.is_none() {
        return Err("dash_plan_expired");
    }
    if task.hls_selection
        && task.hls_plan.is_none()
        && !(task.hls_plan_version >= 2
            && checkpoint_available(&checkpoint_path_for_state(&store.repository.path, &task.id)))
    {
        Err("hls_plan_expired")
    } else {
        Ok(())
    }
}

pub(crate) fn task_control(
    store: &TaskRuntime,
    writer: &Writer,
    payload: &Value,
) -> Result<Task, &'static str> {
    let retry_save = store.repository.runtime_error.lock().unwrap().is_some();
    if retry_save {
        save_store(&store.repository).map_err(|_| "task_store_write_failed")?;
    }
    let id = payload["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("task_id_empty")?;
    let action = payload["action"].as_str().ok_or("task_action_empty")?;
    let task = store
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .ok_or("task_not_found")?;
    if matches!(action, "pause" | "cancel")
        && matches!(task.state.as_str(), "queued" | "paused")
        && remove_pending(store, id)
    {
        update(store, writer, id, |task| {
            task.state = if action == "pause" {
                "paused"
            } else {
                "cancelled"
            }
            .into();
            task.phase = task.state.clone();
            task.message = Some(
                if action == "pause" {
                    "已暂停排队"
                } else {
                    "已取消"
                }
                .into(),
            );
        });
        if store.repository.runtime_error.lock().unwrap().is_some() {
            return Err("task_store_write_failed");
        }
        return store
            .repository
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.id == id)
            .map(sanitized_task)
            .ok_or("task_not_found");
    }
    if matches!(action, "resume" | "retry" | "reauthorize") {
        if matches!(
            task.state.as_str(),
            "queued" | "starting" | "running" | "retrying"
        ) {
            return Ok(sanitized_task(&task));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while scheduler_active(store, id) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if scheduler_active(store, id) {
            return Err("task_still_stopping");
        }
        if task.live_recording && scheduler_full(store) {
            return Err("live_capacity_unavailable");
        }
    }
    match action {
        "stop" => {
            if !task.live_recording {
                return Err("task_not_live");
            }
            if matches!(task.state.as_str(), "succeeded" | "partial") {
                return Ok(sanitized_task(&task));
            }
            if !matches!(
                task.state.as_str(),
                "queued"
                    | "starting"
                    | "running"
                    | "retrying"
                    | "pausing"
                    | "paused"
                    | "interrupted"
                    | "stopping"
            ) {
                return Err("task_not_stoppable");
            }
            store.stops.lock().unwrap().insert(id.into());
            let needs_restart = matches!(task.state.as_str(), "paused" | "interrupted");
            if needs_restart {
                clear_pause(store, id);
                clear_cancellation(store, id);
            }
            update(store, writer, id, |current| {
                current.state = "stopping".into();
                current.phase = "stopping".into();
                current.message = Some("正在停止录制并保存已下载内容".into());
            });
            if needs_restart {
                let checkpoint =
                    load_checkpoint(&checkpoint_path_for_state(&store.repository.path, id))
                        .map_err(|_| "hls_checkpoint_missing")?;
                let mut resumed = task.clone();
                resumed.state = "stopping".into();
                resumed.hls_plan = Some(runtime_plan_from_persisted(&checkpoint.plan));
                start_download(store.clone(), writer.clone(), resumed);
            }
        }
        "pause" => {
            if task.state == "paused" {
                return Ok(sanitized_task(&task));
            }
            if !matches!(
                task.state.as_str(),
                "queued" | "starting" | "running" | "retrying"
            ) {
                return Err("task_not_pauseable");
            }
            store.pauses.lock().unwrap().insert(id.into());
            store.cancellations.lock().unwrap().insert(id.into(), true);
            update(store, writer, id, |task| {
                task.state = "pausing".into();
                task.phase = "pausing".into();
                task.message = Some("正在暂停下载".into());
            });
            stop_process(store, id);
            if !wait_for_state(
                store,
                id,
                &["paused"],
                Instant::now() + Duration::from_secs(5),
            ) {
                clear_pause(store, id);
                clear_cancellation(store, id);
                return Err("pause_failed");
            }
        }
        "cancel" => {
            if task.state == "cancelled" {
                return Ok(sanitized_task(&task));
            }
            if !matches!(
                task.state.as_str(),
                "queued" | "starting" | "running" | "retrying" | "pausing" | "paused"
            ) {
                return Err("task_not_cancellable");
            }
            clear_pause(store, id);
            clear_stop(store, id);
            store.cancellations.lock().unwrap().insert(id.into(), true);
            update(store, writer, id, |task| {
                task.state = "cancelling".into();
                task.phase = "cancelling".into();
                task.message = Some("正在取消下载".into());
            });
            stop_process(store, id);
            if task.state == "paused" {
                mark_stopped(store, writer, id);
            }
            if !wait_for_state(
                store,
                id,
                &["cancelled"],
                Instant::now() + Duration::from_secs(5),
            ) {
                clear_cancellation(store, id);
                return Err("cancel_failed");
            }
        }
        "resume" | "retry" | "reauthorize" => {
            let allowed = if action == "resume" {
                matches!(task.state.as_str(), "paused" | "interrupted")
            } else if action == "reauthorize" {
                task.state == "interrupted"
            } else {
                matches!(
                    task.state.as_str(),
                    "failed" | "partial" | "cancelled" | "interrupted" | "paused"
                )
            };
            if !allowed {
                return Err(if action == "resume" {
                    "task_not_resumable"
                } else if action == "reauthorize" {
                    "task_not_awaiting_authorization"
                } else {
                    "task_not_retryable"
                });
            }
            ensure_restart_context(store, &task)?;
            let resume_context = payload
                .get("resumeContext")
                .filter(|value| value.is_object());
            let resumed_headers = resume_context
                .map(allowed_request_headers)
                .unwrap_or_default();
            let resumed_key_override = resume_context
                .and_then(|value| value.get("keyOverride"))
                .filter(|value| !value.is_null())
                .map(|value| {
                    parse_key_override(
                        value["kind"].as_str().unwrap_or(""),
                        value["value"].as_str().unwrap_or(""),
                        value["iv"].as_str(),
                    )
                    .map_err(|_| "hls_key_override_invalid")
                })
                .transpose()?;
            let mut resumed_plan = task.hls_plan.clone().or_else(|| {
                (task.hls_plan_version >= 2)
                    .then(|| {
                        load_checkpoint(&checkpoint_path_for_state(
                            &store.repository.path,
                            &task.id,
                        ))
                        .ok()
                    })
                    .flatten()
                    .map(|checkpoint| runtime_plan_from_persisted(&checkpoint.plan))
            });
            if let (Some(plan), Some(key_override)) = (resumed_plan.as_mut(), resumed_key_override)
            {
                plan.key_override = Some(key_override);
            }
            if task
                .resume_requirement
                .as_deref()
                .is_some_and(|value| value.contains("authorization"))
                && !resumed_headers
                    .keys()
                    .any(|name| is_sensitive_request_header(name))
            {
                return Err("hls_authorization_required");
            }
            if task
                .resume_requirement
                .as_deref()
                .is_some_and(|value| value.contains("key"))
                && !resumed_plan
                    .as_ref()
                    .is_some_and(|plan| plan.key_override.is_some())
            {
                return Err("hls_key_required");
            }
            clear_pause(store, id);
            clear_cancellation(store, id);
            clear_stop(store, id);
            update(store, writer, id, move |task| {
                if !resumed_headers.is_empty() {
                    if resumed_headers
                        .keys()
                        .any(|name| is_sensitive_request_header(name))
                    {
                        task.requires_authorization = true;
                    }
                    task.request_headers = resumed_headers;
                }
                if let Some(plan) = resumed_plan {
                    task.hls_plan = Some(plan);
                }
                task.state = "queued".into();
                task.phase = "queued".into();
                task.attempt = task.attempt.saturating_add(1);
                task.error = None;
                task.speed_bytes_per_second = 0;
                task.eta_seconds = None;
                task.resume_requirement = None;
                task.message = Some(
                    if action == "resume" {
                        "正在恢复下载"
                    } else if action == "reauthorize" {
                        "授权已更新，正在继续下载"
                    } else {
                        "正在重新下载"
                    }
                    .into(),
                );
            });
            if store.repository.runtime_error.lock().unwrap().is_some() {
                return Err("task_store_write_failed");
            }
            {
                let mut tasks = store.repository.tasks.lock().unwrap();
                if let Some(index) = tasks.iter().position(|task| task.id == id) {
                    let task = tasks.remove(index);
                    tasks.push(task);
                    persist_tasks(&store.repository, &tasks)
                        .map_err(|_| "task_store_write_failed")?;
                }
            }
            let restarted = store
                .repository
                .tasks
                .lock()
                .unwrap()
                .iter()
                .find(|task| task.id == id)
                .cloned()
                .ok_or("task_not_found")?;
            start_download(store.clone(), writer.clone(), restarted);
        }
        _ => return Err("task_action_unsupported"),
    }
    if store.repository.runtime_error.lock().unwrap().is_some() {
        return Err("task_store_write_failed");
    }
    store
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .map(sanitized_task)
        .ok_or("task_not_found")
}

pub(crate) fn delete_output(path: &str) -> Result<bool, &'static str> {
    let path = Path::new(path);
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("file_delete_failed"),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("file_delete_unsafe");
    }
    fs::remove_file(path).map_err(|_| "file_delete_failed")?;
    Ok(true)
}

pub(crate) fn task_output_paths(task: &Task) -> HashSet<String> {
    let mut paths = HashSet::new();
    if let Some(path) = &task.output {
        paths.insert(path.clone());
    }
    for output in &task.outputs {
        if let Some(path) = &output.path {
            paths.insert(path.clone());
        }
    }
    paths
}

pub(crate) fn delete_task_outputs(task: &Task) -> Result<bool, &'static str> {
    let mut deleted = false;
    for path in task_output_paths(task) {
        deleted |= delete_output(&path)?;
    }
    Ok(deleted)
}

pub(crate) fn delete_task(
    store: &TaskRuntime,
    writer: &Writer,
    payload: &Value,
) -> Result<Value, &'static str> {
    let id = payload["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("task_id_empty")?;
    let delete_file = payload["deleteFile"].as_bool().unwrap_or(false);
    let task = store
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .find(|task| task.id == id)
        .cloned()
        .ok_or("task_not_found")?;
    let queued = remove_pending(store, id);
    if !queued
        && matches!(
            task.state.as_str(),
            "queued" | "starting" | "running" | "retrying" | "pausing" | "cancelling"
        )
    {
        clear_pause(store, id);
        update(store, writer, id, |task| {
            task.state = "cancelling".into();
            task.phase = "cancelling".into();
            task.message = Some("正在取消下载".into());
        });
        store.cancellations.lock().unwrap().insert(id.into(), true);
        stop_process(store, id);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let terminal = store
                .repository
                .tasks
                .lock()
                .unwrap()
                .iter()
                .find(|item| item.id == id)
                .map(|item| {
                    matches!(
                        item.state.as_str(),
                        "cancelled" | "succeeded" | "failed" | "interrupted"
                    )
                })
                .unwrap_or(true);
            if terminal || Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let cancelled = store
            .repository
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .map(|item| {
                matches!(
                    item.state.as_str(),
                    "cancelled" | "succeeded" | "failed" | "interrupted"
                )
            })
            .unwrap_or(false);
        if !cancelled {
            clear_cancellation(store, id);
            update(store, writer, id, |task| {
                task.state = "failed".into();
                task.phase = "failed".into();
                task.error = Some("cancel_failed".into());
                task.message = Some("取消下载失败，任务和文件均已保留".into());
            });
            return Err("cancel_failed");
        }
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while scheduler_active(store, id) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    if scheduler_active(store, id) {
        return Err("task_still_stopping");
    }
    let file_deleted = if delete_file {
        delete_task_outputs(&task)?
    } else {
        false
    };
    {
        let mut tasks = store.repository.tasks.lock().unwrap();
        let before = tasks.clone();
        tasks.retain(|item| item.id != id);
        if tasks.len() == before.len() {
            return Err("task_not_found");
        }
        if persist_tasks(&store.repository, &tasks).is_err() {
            *tasks = before;
            return Err("task_store_write_failed");
        }
    }
    clear_cancellation(store, id);
    clear_pause(store, id);
    let _ = fs::remove_dir_all(task_work_root_for_state(&store.repository.path).join(id));
    emit(writer, json!({"version":1,"type":"task.deleted","id":id}));
    Ok(
        json!({"id": id, "fileDeleted": file_deleted, "fileKept": !delete_file && task.output.is_some()}),
    )
}
