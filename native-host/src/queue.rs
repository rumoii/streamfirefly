use std::collections::HashSet;
use std::collections::VecDeque;

#[derive(Default)]
pub(crate) struct QueueState {
    pub(crate) pending: VecDeque<String>,
    pub(crate) running: HashSet<String>,
}
