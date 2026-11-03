use crate::model::Task;
use crate::model::TaskOutput;
use crate::paths::checkpoint_available;
use crate::paths::checkpoint_path_for_state;
use crate::persistence::replace_file;
use serde_json::json;
use serde_json::Value;
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

pub(crate) const STORE_VERSION: u8 = 1;
const SENSITIVE_REQUEST_HEADERS: [&str; 2] = ["cookie", "authorization"];
pub(crate) struct TaskRepository {
    pub(crate) path: PathBuf,
    pub(crate) tasks: Mutex<Vec<Task>>,
    persistence: Mutex<()>,
    pub(crate) load_error: Option<String>,
    pub(crate) runtime_error: Mutex<Option<String>>,
}

pub(crate) fn load_repository(path: &Path) -> TaskRepository {
    let load_error = match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(value)
                if value["version"].as_u64() == Some(STORE_VERSION.into())
                    && serde_json::from_value::<Vec<Task>>(value["tasks"].clone()).is_ok() =>
            {
                None
            }
            _ => Some("task_store_format_unsupported".to_string()),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => Some("task_store_read_failed".to_string()),
    };
    let mut tasks: Vec<Task> = fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| {
            (v["version"].as_u64() == Some(STORE_VERSION.into()))
                .then(|| serde_json::from_value(v["tasks"].clone()).ok())
                .flatten()
        })
        .unwrap_or_default();
    for task in &mut tasks {
        let paused = task.state == "paused";
        let had_credentials = task.requires_authorization
            || task
                .request_headers
                .keys()
                .any(|name| is_sensitive_request_header(name));
        strip_sensitive_headers(task);
        if task.dash_selection && !matches!(task.state.as_str(), "succeeded" | "cancelled") {
            task.resume_requirement = Some("dash_reparse_required".into());
            task.message = Some("DASH 计划未持久化，请回到资源页重新解析并创建任务".into());
        }
        if matches!(
            task.state.as_str(),
            "running"
                | "paused"
                | "queued"
                | "starting"
                | "downloading"
                | "retrying"
                | "pausing"
                | "cancelling"
                | "stopping"
        ) {
            let recoverable_hls = task.hls_plan_version >= 2
                && checkpoint_available(&checkpoint_path_for_state(path, &task.id));
            task.state = if paused { "paused" } else { "interrupted" }.into();
            task.phase = "interrupted".into();
            task.error = Some("native_host_restarted".into());
            task.resume_requirement = if task.dash_selection {
                Some("dash_reparse_required".into())
            } else if !recoverable_hls {
                had_credentials.then(|| "authorization_required".into())
            } else if had_credentials && task.requires_key_override {
                Some("authorization_and_key_required".into())
            } else if had_credentials {
                Some("authorization_required".into())
            } else if task.requires_key_override {
                Some("key_required".into())
            } else {
                None
            };
            task.checkpoint_state = task.hls_selection.then(|| {
                if recoverable_hls {
                    "recoverable"
                } else {
                    "missing"
                }
                .into()
            });
            task.message = Some(if task.dash_selection {
                "DASH 计划未持久化，请回到资源页重新解析并创建任务".into()
            } else if !recoverable_hls {
                if had_credentials {
                    "登录凭据未持久化，请从页面重新发起下载"
                } else {
                    "本地助手重新启动，请重新发起下载"
                }
                .into()
            } else if had_credentials {
                "登录凭据未持久化，请回到来源页面重新授权后继续".into()
            } else if task.requires_key_override {
                "自定义密钥未持久化，请重新输入后继续".into()
            } else {
                "本地助手重新启动，正在恢复已完成切片".into()
            });
            for output in &mut task.outputs {
                if matches!(output.state.as_str(), "queued" | "starting" | "running") {
                    output.state = "interrupted".into();
                    output.error = Some("native_host_restarted".into());
                }
            }
        }
    }
    let store = TaskRepository {
        path: path.to_path_buf(),
        tasks: Mutex::new(tasks),
        persistence: Mutex::new(()),
        load_error,
        runtime_error: Mutex::new(None),
    };
    if store.load_error.is_none() {
        let _ = save_store(&store);
    }
    store
}

pub(crate) fn save_store(store: &TaskRepository) -> io::Result<()> {
    let tasks = store.tasks.lock().unwrap();
    persist_tasks(store, &tasks)
}

pub(crate) fn persist_tasks(store: &TaskRepository, tasks: &[Task]) -> io::Result<()> {
    let result = write_tasks(store, tasks);
    *store.runtime_error.lock().unwrap() = result
        .as_ref()
        .err()
        .map(|_| "task_store_write_failed".to_string());
    result
}

fn write_tasks(store: &TaskRepository, tasks: &[Task]) -> io::Result<()> {
    let _persistence = store.persistence.lock().unwrap();
    if let Some(error) = &store.load_error {
        return Err(io::Error::other(error.clone()));
    }
    if let Some(parent) = store.path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data = json!({"version": STORE_VERSION, "tasks": sanitized_tasks(tasks)});
    let temporary = store.path.with_extension("tmp");
    let mut file = fs::File::create(&temporary)?;
    file.write_all(&serde_json::to_vec_pretty(&data)?)?;
    file.sync_all()?;
    drop(file);
    replace_file(&temporary, &store.path)
}

pub(crate) fn is_sensitive_request_header(name: &str) -> bool {
    SENSITIVE_REQUEST_HEADERS
        .iter()
        .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
}

pub(crate) fn strip_sensitive_headers(task: &mut Task) {
    task.request_headers
        .retain(|name, _| !is_sensitive_request_header(name));
}

pub(crate) fn sanitized_task(task: &Task) -> Task {
    let mut copy = task.clone();
    strip_sensitive_headers(&mut copy);
    copy.inline_manifest = None;
    copy.hls_plan = None;
    copy.dash_plan = None;
    if copy.outputs.len() <= 1 {
        if let Some(primary) = copy
            .outputs
            .iter_mut()
            .find(|output| output.kind == "media")
        {
            primary.state = copy.state.clone();
            primary.error = copy.error.clone();
        }
    }
    if copy.outputs.is_empty() && copy.output.is_some() {
        copy.outputs.push(TaskOutput {
            kind: "media".into(),
            language: None,
            label: None,
            path: copy.output.clone(),
            state: copy.state.clone(),
            error: copy.error.clone(),
        });
    }
    copy
}

pub(crate) fn sanitized_tasks(tasks: &[Task]) -> Vec<Task> {
    tasks.iter().map(sanitized_task).collect()
}
