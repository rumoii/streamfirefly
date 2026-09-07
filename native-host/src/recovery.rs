use crate::hls::load_checkpoint;
use crate::hls_plan::runtime_plan_from_persisted;
use crate::model::Task;
use crate::paths::checkpoint_available;
use crate::paths::checkpoint_path_for_state;
use crate::runtime::TaskRuntime;
use crate::scheduler::start_download;
use crate::task_state::update;
use crate::wire::Writer;
use std::sync::atomic::Ordering;

pub(crate) fn resume_recoverable_hls_tasks(store: &TaskRuntime, writer: &Writer) {
    let resumable: Vec<Task> = store
        .repository
        .tasks
        .lock()
        .unwrap()
        .iter()
        .filter(|task| {
            task.state == "interrupted"
                && !task.live_recording
                && task.resume_requirement.is_none()
                && (!task.hls_selection
                    || checkpoint_available(&checkpoint_path_for_state(
                        &store.repository.path,
                        &task.id,
                    )))
        })
        .cloned()
        .collect();
    for mut task in resumable {
        if task.hls_selection {
            let Ok(checkpoint) =
                load_checkpoint(&checkpoint_path_for_state(&store.repository.path, &task.id))
            else {
                continue;
            };
            task.hls_plan = Some(runtime_plan_from_persisted(&checkpoint.plan));
        }
        update(store, writer, &task.id, |current| {
            current.state = "queued".into();
            current.phase = "recovering".into();
            current.hls_plan = task.hls_plan.clone();
            current.attempt = current.attempt.saturating_add(1);
            current.error = None;
            current.message = Some("已重新排队，等待恢复下载".into());
        });
        task.state = "queued".into();
        start_download(store.clone(), writer.clone(), task);
    }
}

pub(crate) fn start_recovery_once(store: &TaskRuntime, writer: &Writer) {
    if store
        .recovery_started
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
    {
        resume_recoverable_hls_tasks(store, writer);
    }
}
