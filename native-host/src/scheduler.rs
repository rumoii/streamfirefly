use super::*;

const MAX_ACTIVE_TASKS: usize = 2;

#[derive(Default)]
pub(super) struct Scheduler {
    pending: VecDeque<String>,
    running: HashSet<String>,
}

pub(super) fn scheduler_active(store: &Store, id: &str) -> bool {
    store.scheduler.lock().unwrap().running.contains(id)
}

pub(super) fn scheduler_full(store: &Store) -> bool {
    let scheduler = store.scheduler.lock().unwrap();
    scheduler.running.len() >= MAX_ACTIVE_TASKS || !scheduler.pending.is_empty()
}

pub(super) fn remove_pending(store: &Store, id: &str) -> bool {
    let mut scheduler = store.scheduler.lock().unwrap();
    if scheduler.running.contains(id) {
        return false;
    }
    scheduler.pending.retain(|pending| pending != id);
    true
}

pub(super) fn start_download(store: Store, writer: Writer, task: Task) {
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
    store: Store,
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

fn pump(store: &Store, writer: &Writer) {
    let mut scheduler = store.scheduler.lock().unwrap();
    while scheduler.running.len() < MAX_ACTIVE_TASKS {
        let Some(id) = scheduler.pending.pop_front() else {
            break;
        };
        let task = store
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
