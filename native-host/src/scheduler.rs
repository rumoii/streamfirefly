use crate::model::Task;
use crate::lock::LockExt;
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
    store.scheduler.lock_or_recover().running.contains(id)
}

pub(crate) fn scheduler_full(store: &TaskRuntime) -> bool {
    let scheduler = store.scheduler.lock_or_recover();
    scheduler.running.len() >= MAX_ACTIVE_TASKS || !scheduler.pending.is_empty()
}

pub(crate) fn remove_pending(store: &TaskRuntime, id: &str) -> bool {
    let mut scheduler = store.scheduler.lock_or_recover();
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
        let mut scheduler = store.scheduler.lock_or_recover();
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
            .lock_or_recover()
            .running
            .remove(&self.id);
        pump(&self.store, &self.writer);
    }
}

fn pump(store: &TaskRuntime, writer: &Writer) {
    if crate::runtime::host_exiting(store) {
        return;
    }
    let mut scheduler = store.scheduler.lock_or_recover();
    while scheduler.running.len() < MAX_ACTIVE_TASKS {
        let Some(id) = scheduler.pending.pop_front() else {
            break;
        };
        let task = store
            .repository
            .tasks
            .lock_or_recover()
            .iter()
            .find(|task| task.id == id)
            .cloned();
        let Some(task) = task else {
            continue;
        };
        // Stopping a live recording saves local media without resuming network access.
        if (task.resume_requirement.is_some() && !(task.live_recording && task.state == "stopping"))
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
    use std::io;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::{Arc, Mutex};

    #[test]
    fn dropping_a_running_task_releases_its_slot_and_pumps_after_poisoning() {
        let path = std::env::temp_dir()
            .join(format!("streamfirefly-queue-{}", Uuid::new_v4()))
            .join("tasks.json");
        let store = load_store(&path);
        let running = RunningTask {
            store: store.clone(),
            writer: Arc::new(Mutex::new(io::BufWriter::new(io::stdout()))),
            id: "running".into(),
        };
        let poisoned = catch_unwind(AssertUnwindSafe(|| {
            let mut queue = store.scheduler.lock().unwrap();
            let _tasks = store.repository.tasks.lock().unwrap();
            queue.running.insert(running.id.clone());
            queue.pending.push_back("missing-task".into());
            panic!("controlled scheduler and task table poisoning");
        }));
        assert!(poisoned.is_err());
        assert!(store.scheduler.is_poisoned());
        assert!(store.repository.tasks.is_poisoned());
        let dropped = catch_unwind(AssertUnwindSafe(|| drop(running)));
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
        assert!(dropped.is_ok(), "running-task cleanup panicked after poisoning");
        let queue = store.scheduler.lock_or_recover();
        assert!(queue.running.is_empty());
        assert!(queue.pending.is_empty());
    }

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
