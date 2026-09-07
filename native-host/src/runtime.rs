use crate::queue::QueueState;
use crate::repository::load_repository;
use crate::repository::TaskRepository;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Clone)]
pub(crate) struct TaskRuntime {
    pub(crate) repository: Arc<TaskRepository>,
    pub(crate) processes: Arc<Mutex<HashMap<String, Vec<Arc<Mutex<Child>>>>>>,
    pub(crate) cancellations: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) pauses: Arc<Mutex<HashSet<String>>>,
    pub(crate) stops: Arc<Mutex<HashSet<String>>>,
    pub(crate) recovery_started: Arc<AtomicBool>,
    pub(crate) scheduler: Arc<Mutex<QueueState>>,
    pub(crate) creation: Arc<Mutex<()>>,
}

pub(crate) fn load_store(path: &Path) -> TaskRuntime {
    let repository = Arc::new(load_repository(path));
    TaskRuntime {
        repository,
        processes: Arc::new(Mutex::new(HashMap::new())),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
        pauses: Arc::new(Mutex::new(HashSet::new())),
        stops: Arc::new(Mutex::new(HashSet::new())),
        recovery_started: Arc::new(AtomicBool::new(false)),
        scheduler: Arc::new(Mutex::new(QueueState::default())),
        creation: Arc::new(Mutex::new(())),
    }
}
