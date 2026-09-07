use super::*;

pub(super) fn load_store(path: &Path) -> Store {
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
            task.resume_requirement = if !recoverable_hls {
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
            task.message = Some(if !recoverable_hls {
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
    let store = Store {
        path: path.to_path_buf(),
        tasks: Arc::new(Mutex::new(tasks)),
        processes: Arc::new(Mutex::new(HashMap::new())),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
        pauses: Arc::new(Mutex::new(HashSet::new())),
        stops: Arc::new(Mutex::new(HashSet::new())),
        recovery_started: Arc::new(AtomicBool::new(false)),
        scheduler: Arc::new(Mutex::new(scheduler::Scheduler::default())),
        persistence: Arc::new(Mutex::new(())),
        creation: Arc::new(Mutex::new(())),
        load_error,
        runtime_error: Arc::new(Mutex::new(None)),
    };
    if store.load_error.is_none() {
        let _ = save_store(&store);
    }
    store
}

pub(super) fn save_store(store: &Store) -> io::Result<()> {
    let tasks = store.tasks.lock().unwrap();
    persist_tasks(store, &tasks)
}

pub(super) fn persist_tasks(store: &Store, tasks: &[Task]) -> io::Result<()> {
    let result = write_tasks(store, tasks);
    *store.runtime_error.lock().unwrap() = result
        .as_ref()
        .err()
        .map(|_| "task_store_write_failed".to_string());
    result
}

fn write_tasks(store: &Store, tasks: &[Task]) -> io::Result<()> {
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

#[cfg(not(windows))]
pub(super) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
pub(super) fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 1 | 8) } == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub(super) fn is_sensitive_request_header(name: &str) -> bool {
    SENSITIVE_REQUEST_HEADERS
        .iter()
        .any(|sensitive| name.eq_ignore_ascii_case(sensitive))
}

pub(super) fn strip_sensitive_headers(task: &mut Task) {
    task.request_headers
        .retain(|name, _| !is_sensitive_request_header(name));
}

pub(super) fn sanitized_task(task: &Task) -> Task {
    let mut copy = task.clone();
    strip_sensitive_headers(&mut copy);
    copy.inline_manifest = None;
    copy.hls_plan = None;
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

pub(super) fn sanitized_tasks(tasks: &[Task]) -> Vec<Task> {
    tasks.iter().map(sanitized_task).collect()
}
