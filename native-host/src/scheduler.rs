use crate::model::Task;
#[cfg(test)]
use crate::runtime::load_store;
use crate::runtime::TaskRuntime;
use crate::task_runner::run_download;
use crate::wire::Writer;
#[cfg(test)]
use std::fs;
use std::thread;
#[cfg(test)]
use uuid::Uuid;

const MAX_ACTIVE_TASKS: usize = 2;

pub(crate) fn scheduler_active(store: &TaskRuntime, id: &str) -> bool {
    store.scheduler.lock().unwrap().running.contains(id)
}

pub(crate) fn scheduler_full(store: &TaskRuntime) -> bool {
    let scheduler = store.scheduler.lock().unwrap();
    scheduler.running.len() >= MAX_ACTIVE_TASKS || !scheduler.pending.is_empty()
}

pub(crate) fn remove_pending(store: &TaskRuntime, id: &str) -> bool {
    let mut scheduler = store.scheduler.lock().unwrap();
    if scheduler.running.contains(id) {
        return false;
    }
    scheduler.pending.retain(|pending| pending != id);
    true
}

pub(crate) fn start_download(store: TaskRuntime, writer: Writer, task: Task) {
    if crate::runtime::host_exiting(&store) {
        return;
    }
    {
        let mut scheduler = store.scheduler.lock().unwrap();
        if scheduler.running.contains(&task.id) || scheduler.pending.contains(&task.id) {
            return;
        }
        if !matches!(
            task.state.as_str(),
            "queued" | "retrying" | "stopping" | "interrupted"
        ) {
            return;
        }
        scheduler.pending.push_back(task.id);
    }
    pump(&store, &writer);
}

struct RunningTask {
    store: TaskRuntime,
    writer: Writer,
    id: String,
}

impl Drop for RunningTask {
    fn drop(&mut self) {
        self.store
            .scheduler
            .lock()
            .unwrap()
            .running
            .remove(&self.id);
        pump(&self.store, &self.writer);
    }
}

fn pump(store: &TaskRuntime, writer: &Writer) {
    if crate::runtime::host_exiting(store) {
        return;
    }
    let mut scheduler = store.scheduler.lock().unwrap();
    while scheduler.running.len() < MAX_ACTIVE_TASKS {
        let Some(id) = scheduler.pending.pop_front() else {
            break;
        };
        let task = store
            .repository
            .tasks
            .lock()
            .unwrap()
            .iter()
            .find(|task| task.id == id)
            .cloned();
        let Some(task) = task else {
            continue;
        };
        if task.resume_requirement.is_some()
            || !matches!(
                task.state.as_str(),
                "queued" | "retrying" | "stopping" | "interrupted"
            )
        {
            continue;
        }
        scheduler.running.insert(id.clone());
        let store = store.clone();
        let writer = writer.clone();
        thread::spawn(move || {
            let _running = RunningTask {
                store: store.clone(),
                writer: writer.clone(),
                id,
            };
            run_download(store, writer, task);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_can_be_removed_without_starting_a_worker() {
        let path = std::env::temp_dir()
            .join(format!("streamfirefly-queue-{}", Uuid::new_v4()))
            .join("tasks.json");
        let store = load_store(&path);
        store
            .scheduler
            .lock()
            .unwrap()
            .pending
            .push_back("queued".into());
        assert!(remove_pending(&store, "queued"));
        assert!(store.scheduler.lock().unwrap().pending.is_empty());
        store
            .scheduler
            .lock()
            .unwrap()
            .running
            .insert("running".into());
        assert!(!remove_pending(&store, "running"));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
