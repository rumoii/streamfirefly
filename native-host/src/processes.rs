use crate::runtime::TaskRuntime;
use crate::task_state::update;
use crate::wire::Writer;
use std::process::Child;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

pub(crate) fn register_process(store: &TaskRuntime, id: &str, child: Child) -> Arc<Mutex<Child>> {
    let child = Arc::new(Mutex::new(child));
    store
        .processes
        .lock()
        .unwrap()
        .entry(id.into())
        .or_default()
        .push(child.clone());
    child
}

pub(crate) fn unregister_process(store: &TaskRuntime, id: &str, process: &Arc<Mutex<Child>>) {
    let mut processes = store.processes.lock().unwrap();
    if let Some(items) = processes.get_mut(id) {
        items.retain(|item| !Arc::ptr_eq(item, process));
        if items.is_empty() {
            processes.remove(id);
        }
    }
}

pub(crate) fn unregister_all_processes(store: &TaskRuntime, id: &str) {
    store.processes.lock().unwrap().remove(id);
}

pub(crate) fn clear_cancellation(store: &TaskRuntime, id: &str) {
    store.cancellations.lock().unwrap().remove(id);
}

pub(crate) fn clear_pause(store: &TaskRuntime, id: &str) {
    store.pauses.lock().unwrap().remove(id);
}

pub(crate) fn clear_stop(store: &TaskRuntime, id: &str) {
    store.stops.lock().unwrap().remove(id);
}

pub(crate) fn pause_requested(store: &TaskRuntime, id: &str) -> bool {
    store.pauses.lock().unwrap().contains(id)
}

pub(crate) fn cancel_requested(store: &TaskRuntime, id: &str) -> bool {
    store.cancellations.lock().unwrap().contains_key(id)
}

pub(crate) fn stop_requested(store: &TaskRuntime, id: &str) -> bool {
    store.stops.lock().unwrap().contains(id)
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
