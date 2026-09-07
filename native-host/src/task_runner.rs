use crate::hls_download::start_hls_checkpoint_download;
use crate::http_download::start_http_download;
use crate::media_process::bundled_tool;
use crate::model::Task;
use crate::processes::cancel_requested;
use crate::processes::mark_stopped;
use crate::processes::register_process;
use crate::processes::unregister_process;
use crate::runtime::TaskRuntime;
use crate::task_state::update;
use crate::wire::Writer;
use std::fs;
use std::io;
use std::path::Path;
use std::process::Command;
use std::process::Stdio;
use std::thread;
use std::time::Duration;
use std::time::Instant;

pub(crate) fn run_download(store: TaskRuntime, writer: Writer, task: Task) {
    if cancel_requested(&store, &task.id) {
        mark_stopped(&store, &writer, &task.id);
        return;
    }
    let Some(output) = task.output.clone() else {
        update(&store, &writer, &task.id, |t| {
            t.state = "failed".into();
            t.phase = "failed".into();
            t.error = Some("output_missing".into());
        });
        return;
    };
    if let Some(parent) = Path::new(&output).parent() {
        let _ = fs::create_dir_all(parent);
    }
    if task.hls_plan_version >= 2 {
        let plan = task.hls_plan.clone();
        start_hls_checkpoint_download(store, writer, task, output, plan);
        return;
    }
    if task.hls_selection
        || task.inline_manifest.is_some()
        || task.url.to_ascii_lowercase().contains(".m3u8")
        || task.mime.as_deref().unwrap_or("").contains("mpegurl")
    {
        update(&store, &writer, &task.id, |task| {
            task.state = "failed".into();
            task.phase = "failed".into();
            task.error = Some("hls_plan_required".into());
            task.message = Some("请重新解析 HLS 并创建切片下载任务".into());
        });
        return;
    }
    let is_stream = task.url.to_ascii_lowercase().contains(".mpd")
        || task.mime.as_deref().unwrap_or("").contains("dash+xml");
    if !is_stream {
        start_http_download(store, writer, task, output);
        return;
    }
    update(&store, &writer, &task.id, |t| {
        t.state = "running".into();
        t.phase = "fetching".into();
        t.message = Some("正在读取流媒体清单，需要 FFmpeg".into());
    });
    let mut ffmpeg_args: Vec<String> = [
        "-nostdin",
        "-y",
        "-loglevel",
        "error",
        "-http_multiple",
        "1",
        "-http_persistent",
        "1",
        "-http_seekable",
        "1",
        "-seg_max_retry",
        "3",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    if !task.request_headers.is_empty() {
        let headers = task
            .request_headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect::<String>();
        ffmpeg_args.extend(["-headers".into(), headers]);
    }
    ffmpeg_args.extend([
        "-i".into(),
        task.url.clone(),
        "-map".into(),
        "0:v?".into(),
        "-map".into(),
        "0:a?".into(),
        "-c".into(),
        "copy".into(),
        output.clone(),
    ]);
    let child = match Command::new(bundled_tool("ffmpeg.exe"))
        .args(ffmpeg_args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            update(&store, &writer, &task.id, |t| {
                t.state = "failed".into();
                t.phase = "failed".into();
                t.error = Some(error.to_string());
                t.message = Some("未找到 FFmpeg".into());
            });
            return;
        }
    };
    let child = register_process(&store, &task.id, child);
    update(&store, &writer, &task.id, |t| {
        t.active_connections = 1;
        t.message = Some("FFmpeg 正在使用持久连接下载并合并流媒体".into());
    });
    let mut last_bytes = 0u64;
    let mut sampled_at = Instant::now();
    loop {
        thread::sleep(Duration::from_millis(500));
        if cancel_requested(&store, &task.id) {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            mark_stopped(&store, &writer, &task.id);
            return;
        }
        let bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(last_bytes);
        let speed = (bytes.saturating_sub(last_bytes) as f64
            / sampled_at.elapsed().as_secs_f64().max(0.001)) as u64;
        last_bytes = bytes;
        sampled_at = Instant::now();
        update(&store, &writer, &task.id, |t| {
            t.state = "running".into();
            t.phase = "merging".into();
            t.downloaded_bytes = bytes;
            t.speed_bytes_per_second = speed;
            t.message = Some("正在下载流媒体分片并合并".into());
        });
        let process_status = child
            .lock()
            .map_err(|_| io::Error::other("process_lock_poisoned"))
            .and_then(|mut child| child.try_wait());
        match process_status {
            Ok(Some(status)) if status.success() => {
                unregister_process(&store, &task.id, &child);
                if cancel_requested(&store, &task.id) {
                    mark_stopped(&store, &writer, &task.id);
                    return;
                }
                update(&store, &writer, &task.id, |t| {
                    t.state = "succeeded".into();
                    t.phase = "completed".into();
                    t.progress = 100;
                    t.downloaded_bytes = fs::metadata(&output).map(|m| m.len()).unwrap_or(bytes);
                    t.total_bytes = Some(t.downloaded_bytes);
                    t.active_connections = 0;
                    t.message = Some("流媒体下载完成".into());
                });
                break;
            }
            Ok(Some(_)) => {
                unregister_process(&store, &task.id, &child);
                if cancel_requested(&store, &task.id) {
                    mark_stopped(&store, &writer, &task.id);
                    return;
                }
                update(&store, &writer, &task.id, |t| {
                    t.state = "failed".into();
                    t.phase = "failed".into();
                    t.error = Some("ffmpeg_unavailable_or_failed".into());
                    t.active_connections = 0;
                    t.message = Some("FFmpeg 无法处理此资源".into());
                });
                break;
            }
            Err(error) => {
                unregister_process(&store, &task.id, &child);
                update(&store, &writer, &task.id, |t| {
                    t.state = "failed".into();
                    t.phase = "failed".into();
                    t.error = Some(error.to_string());
                    t.active_connections = 0;
                });
                break;
            }
            Ok(None) => {}
        }
    }
}
