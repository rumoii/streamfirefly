use crate::model::Task;
use crate::repository::persist_tasks;
use crate::repository::sanitized_task;
use crate::runtime::TaskRuntime;
use crate::wire::emit;
use crate::wire::Writer;
use serde_json::json;

pub(crate) fn update(
    store: &TaskRuntime,
    writer: &Writer,
    id: &str,
    change: impl FnOnce(&mut Task),
) {
    let mut tasks = store.repository.tasks.lock().unwrap();
    let Some(index) = tasks.iter().position(|task| task.id == id) else {
        return;
    };
    change(&mut tasks[index]);
    tasks[index].revision = tasks[index].revision.saturating_add(1);
    if persist_tasks(&store.repository, &tasks).is_err() {
        emit(
            writer,
            json!({"version":1,"type":"task.persistence-error","id":id,"error":"task_store_write_failed"}),
        );
        return;
    }
    let public_task = sanitized_task(&tasks[index]);
    emit(
        writer,
        json!({"version":1,"type":"task.progress","task":public_task}),
    );
}
