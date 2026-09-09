use crate::hls_download::start_hls_checkpoint_download;
use crate::http_download::start_http_download;
use crate::model::Task;
use crate::processes::{cancel_requested, mark_stopped};
use crate::runtime::TaskRuntime;
use crate::task_state::update;
use crate::wire::Writer;

pub(crate) fn run_download(store: TaskRuntime, writer: Writer, task: Task) {
    if cancel_requested(&store, &task.id) {
        mark_stopped(&store, &writer, &task.id);
        return;
    }
    let Some(output) = task.output.clone() else {
        update(&store, &writer, &task.id, |task| {
            task.state = "failed".into();
            task.phase = "failed".into();
            task.error = Some("output_missing".into());
        });
        return;
    };
    if task.dash_selection {
        crate::dash_download::start_dash_download(store, writer, task, output);
    } else if task.hls_plan_version >= 2 {
        let plan = task.hls_plan.clone();
        start_hls_checkpoint_download(store, writer, task, output, plan);
    } else if task.hls_selection
        || task.inline_manifest.is_some()
        || task.url.to_ascii_lowercase().contains(".m3u8")
        || task.mime.as_deref().unwrap_or("").contains("mpegurl")
        || task.url.to_ascii_lowercase().contains(".mpd")
        || task.mime.as_deref().unwrap_or("").contains("dash+xml")
    {
        update(&store, &writer, &task.id, |task| {
            task.state = "failed".into();
            task.phase = "failed".into();
            task.error = Some(
                if task.url.to_ascii_lowercase().contains(".mpd")
                    || task.mime.as_deref().unwrap_or("").contains("dash+xml")
                {
                    "dash_plan_required"
                } else {
                    "hls_plan_required"
                }
                .into(),
            );
            task.message = Some("请重新解析清单并创建下载任务".into());
        });
    } else {
        start_http_download(store, writer, task, output);
    }
}
