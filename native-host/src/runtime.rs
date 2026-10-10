use crate::network::NetworkConfig;
use crate::queue::QueueState;
use crate::repository::load_repository;
use crate::repository::TaskRepository;
use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::sync::Mutex;

/// True once the host began shutting down: no new children, retries or scheduled starts.
pub(crate) fn host_exiting(store: &TaskRuntime) -> bool {
    store.exiting.load(Ordering::SeqCst)
}

#[derive(Clone)]
pub(crate) struct TaskRuntime {
    pub(crate) repository: Arc<TaskRepository>,
    pub(crate) processes: Arc<Mutex<HashMap<String, Vec<Arc<Mutex<Child>>>>>>,
    pub(crate) cancellations: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) pauses: Arc<Mutex<HashSet<String>>>,
    pub(crate) stops: Arc<Mutex<HashSet<String>>>,
    pub(crate) recovery_started: Arc<AtomicBool>,
    pub(crate) network_configured: Arc<AtomicBool>,
    pub(crate) recovery_requested: Arc<AtomicBool>,
    pub(crate) exiting: Arc<AtomicBool>,
    pub(crate) scheduler: Arc<Mutex<QueueState>>,
    pub(crate) creation: Arc<Mutex<()>>,
    pub(crate) network: Arc<Mutex<NetworkConfig>>,
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
        network_configured: Arc::new(AtomicBool::new(false)),
        recovery_requested: Arc::new(AtomicBool::new(false)),
        exiting: Arc::new(AtomicBool::new(false)),
        scheduler: Arc::new(Mutex::new(QueueState::default())),
        creation: Arc::new(Mutex::new(())),
        network: Arc::new(Mutex::new(NetworkConfig::default())),
    }
}
