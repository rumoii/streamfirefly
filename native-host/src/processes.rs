use crate::runtime::host_exiting;
use crate::runtime::TaskRuntime;
use crate::task_state::update;
use crate::wire::Writer;
use std::process::{Child, Command};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;
use crate::lock::LockExt;

pub(crate) fn spawn_process(store: &TaskRuntime, id: &str, command: &mut Command) -> std::io::Result<Arc<Mutex<Child>>> {
    let mut processes = store.processes.lock().map_err(|_| std::io::Error::other("process_registry_poisoned"))?;
    if host_exiting(store) {
        return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "host_stopping"));
    }
    let child = Arc::new(Mutex::new(command.spawn()?));
    processes.entry(id.into()).or_default().push(child.clone());
    Ok(child)
}

pub(crate) fn shutdown_processes(store: &TaskRuntime) -> Result<(), String> {
    let children = {
        let processes = store.processes.lock().map_err(|_| "process_registry_poisoned")?;
        store.exiting.store(true, std::sync::atomic::Ordering::SeqCst);
        processes.values().flatten().cloned().collect::<Vec<_>>()
    };
    let mut errors = Vec::new();
    for child in children {
        let result = (|| -> std::io::Result<()> {
            let mut child = child.lock().map_err(|_| std::io::Error::other("process_lock_poisoned"))?;
            if child.try_wait()?.is_none() {
                child.kill()?;
                child.wait()?;
            }
            Ok(())
        })();
        if let Err(error) = result { errors.push(error.to_string()); }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors.join(",")) }
}

pub(crate) fn unregister_process(store: &TaskRuntime, id: &str, process: &Arc<Mutex<Child>>) {
    let mut processes = store.processes.lock_or_recover();
    if let Some(items) = processes.get_mut(id) {
        items.retain(|item| !Arc::ptr_eq(item, process));
        if items.is_empty() {
            processes.remove(id);
        }
    }
}

pub(crate) fn unregister_all_processes(store: &TaskRuntime, id: &str) {
    store.processes.lock_or_recover().remove(id);
}

pub(crate) fn clear_cancellation(store: &TaskRuntime, id: &str) {
    store.cancellations.lock_or_recover().remove(id);
}

pub(crate) fn clear_pause(store: &TaskRuntime, id: &str) {
    store.pauses.lock_or_recover().remove(id);
}

pub(crate) fn clear_stop(store: &TaskRuntime, id: &str) {
    store.stops.lock_or_recover().remove(id);
}

pub(crate) fn pause_requested(store: &TaskRuntime, id: &str) -> bool {
    store.pauses.lock_or_recover().contains(id)
}

pub(crate) fn cancel_requested(store: &TaskRuntime, id: &str) -> bool {
    store.cancellations.lock_or_recover().contains_key(id)
}

pub(crate) fn stop_requested(store: &TaskRuntime, id: &str) -> bool {
    store.stops.lock_or_recover().contains(id)
}

pub(crate) fn mark_stopped(store: &TaskRuntime, writer: &Writer, id: &str) {
    unregister_all_processes(store, id);
    let paused = pause_requested(store, id);
    update(store, writer, id, |task| {
        task.state = if paused { "paused" } else { "cancelled" }.into();
        task.phase = if paused { "paused" } else { "cancelled" }.into();
        task.speed_bytes_per_second = 0;
        task.eta_seconds = None;
        task.active_connections = 0;
        task.error = None;
        for output in &mut task.outputs {
            if matches!(output.state.as_str(), "queued" | "starting" | "running") {
                output.state = if paused { "paused" } else { "cancelled" }.into();
            }
        }
        task.message = Some(
            if paused {
                "下载已暂停"
            } else {
                "下载已取消"
            }
            .into(),
        );
    });
    clear_cancellation(store, id);
    clear_pause(store, id);
    clear_stop(store, id);
}

pub(crate) fn stop_process(store: &TaskRuntime, id: &str) {
    let processes = store
        .processes
        .lock()
        .unwrap()
        .get(id)
        .cloned()
        .unwrap_or_default();
    for process in processes {
        if let Ok(mut child) = process.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub(crate) fn wait_for_state(
    store: &TaskRuntime,
    id: &str,
    expected: &[&str],
    deadline: Instant,
) -> bool {
    loop {
        let reached = store
            .repository
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|item| item.id == id)
            .map(|item| expected.contains(&item.state.as_str()))
            .unwrap_or(false);
        if reached || Instant::now() >= deadline {
            return reached;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::runtime::load_store;
    use std::os::windows::process::CommandExt;
    use std::sync::mpsc;
    use uuid::Uuid;

    fn sleeper() -> Command {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]).creation_flags(0x08000000);
        command
    }

    #[test]
    fn shutdown_reaps_children_and_rejects_late_spawn() {
        let path = std::env::temp_dir().join(format!("streamfirefly-process-{}", Uuid::new_v4())).join("tasks.json");
        let store = load_store(&path);
        let child = spawn_process(&store, "active", &mut sleeper()).unwrap();
        assert!(child.lock().unwrap().try_wait().unwrap().is_none());
        shutdown_processes(&store).unwrap();
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
        match spawn_process(&store, "late", &mut sleeper()) {
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::Interrupted),
            Ok(child) => {
                let mut child = child.lock().unwrap();
                let _ = child.kill(); let _ = child.wait();
                panic!("spawn was accepted after shutdown");
            }
        }
        shutdown_processes(&store).unwrap();
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn blocked_spawn_checks_shutdown_inside_registry_lock() {
        let path = std::env::temp_dir().join(format!("streamfirefly-process-race-{}", Uuid::new_v4())).join("tasks.json");
        let store = load_store(&path);
        let registry = store.processes.lock().unwrap();
        let worker_store = store.clone();
        let (started, ready) = mpsc::channel();
        let worker = thread::spawn(move || {
            started.send(()).unwrap();
            spawn_process(&worker_store, "late", &mut sleeper())
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        store.exiting.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(registry.is_empty());
        drop(registry);
        match worker.join().unwrap() {
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::Interrupted),
            Ok(child) => {
                let mut child = child.lock().unwrap();
                let _ = child.kill(); let _ = child.wait();
                panic!("blocked spawn crossed the shutdown boundary");
            }
        }
        assert!(store.processes.lock().unwrap().is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
