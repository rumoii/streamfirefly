use crate::media_process::set_output_state;
use crate::model::Task;
use crate::repository::{persist_tasks, sanitized_task};
use crate::runtime::{host_exiting, TaskRuntime};
use crate::task_input::publish_task_output;
use crate::wire::{emit, Writer};
use serde_json::json;
use std::{fs, path::{Path, PathBuf}};
use crate::lock::LockExt;

/// Work file for one output, kept beside the final path so publishing is a same-volume
/// rename. The extension stays last so FFmpeg still picks the matching muxer.
pub(crate) fn publish_work_path(destination: &Path, task_id: &str) -> PathBuf {
    let stem = destination.file_stem().unwrap_or_default().to_string_lossy();
    let name = match destination.extension() {
        Some(extension) => format!("{stem}.streamfirefly-part-{task_id}.{}", extension.to_string_lossy()),
        None => format!("{stem}.streamfirefly-part-{task_id}"),
    };
    destination.with_file_name(name)
}

pub(crate) struct HlsPublication<'a> {
    store: &'a TaskRuntime,
    writer: Option<&'a Writer>,
    id: &'a str,
}

impl<'a> HlsPublication<'a> {
    pub(crate) fn begin(store: &'a TaskRuntime, writer: Option<&'a Writer>, id: &'a str) -> Result<Self, &'static str> {
        if host_exiting(store) { return Err("host_stopping"); }
        Ok(Self { store, writer, id })
    }

    /// Moves the finished work file into place and saves the output state while holding
    /// the task map. Host shutdown takes the same lock before exiting, so a moved file
    /// never outlives the host without its persisted state.
    pub(crate) fn publish(&self, kind: &str, index: usize, source: &Path, destination: &Path) -> Result<(), &'static str> {
        let saved = {
            let mut tasks = self.store.repository.tasks.lock_or_recover();
            if let Err(error) = publish_task_output(source, destination, &tasks, self.id) {
                let _ = fs::remove_file(source);
                return Err(error);
            }
            let saved = self.save(&mut tasks, |task| {
                set_output_state(task, kind, index, "succeeded", None);
                if task.outputs.iter().all(|output| output.state == "succeeded") {
                    complete(task);
                    task.checkpoint_state = Some("recoverable".into());
                }
            });
            if saved.is_err() {
                // The output stays unpublished: hand the file back to its work path.
                let _ = crate::persistence::move_new_file(destination, source);
            }
            saved
        };
        self.notify(saved)
    }

    fn update(&self, change: impl FnOnce(&mut Task)) -> Result<(), &'static str> {
        let saved = self.save(&mut self.store.repository.tasks.lock_or_recover(), change);
        self.notify(saved)
    }

    fn save(&self, tasks: &mut [Task], change: impl FnOnce(&mut Task)) -> Result<Task, &'static str> {
        let index = tasks.iter().position(|task| task.id == self.id).ok_or("task_not_found")?;
        let previous = tasks[index].clone();
        change(&mut tasks[index]);
        tasks[index].revision = tasks[index].revision.saturating_add(1);
        if persist_tasks(&self.store.repository, tasks).is_err() {
            tasks[index] = previous;
            return Err("task_store_write_failed");
        }
        Ok(sanitized_task(&tasks[index]))
    }

    fn notify(&self, saved: Result<Task, &'static str>) -> Result<(), &'static str> {
        if let Some(writer) = self.writer {
            match &saved {
                Ok(public) => emit(writer, json!({"version":1,"type":"task.progress","task":public})),
                Err("task_store_write_failed") => emit(writer, json!({"version":1,"type":"task.persistence-error","id":self.id,"error":"task_store_write_failed"})),
                Err(_) => {}
            }
        }
        saved.map(|_| ())
    }

    pub(crate) fn finish(&self, work: &Path) -> Result<(), &'static str> {
        self.update(|task| {
            complete(task);
            task.checkpoint_state = Some("recoverable".into());
        })?;
        if fs::remove_dir_all(work).is_ok() {
            self.update(|task| task.checkpoint_state = Some("cleaned".into()))?;
        }
        Ok(())
    }
}

fn complete(task: &mut Task) {
    task.state = "succeeded".into();
    task.phase = "completed".into();
    task.progress = 100;
    task.active_connections = 0;
    task.eta_seconds = Some(0);
    task.resume_requirement = None;
    task.error = None;
    task.message = Some(if task.live_recording { "直播录制已停止并保存" } else { "HLS 视频和所选字幕下载完成" }.into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::load_store;
    use std::{sync::{mpsc, atomic::Ordering}, thread, time::Duration};
    use uuid::Uuid;

    fn fixture() -> (PathBuf, TaskRuntime, Task, PathBuf) {
        let root = std::env::temp_dir().join(format!("streamfirefly-publication-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("work")).unwrap();
        let part = publish_work_path(&root.join("movie.mkv"), "publishing");
        fs::write(&part, b"complete-media").unwrap();
        fs::write(root.join("work/checkpoint.json"), b"checkpoint").unwrap();
        let store = load_store(&root.join("tasks.json"));
        let task: Task = serde_json::from_value(json!({"id":"publishing","url":"https://example.test/video.m3u8","title":"movie","mime":"application/vnd.apple.mpegurl","state":"running","progress":90,"output":root.join("movie.mkv"),"error":null,"hls_selection":true,"hls_plan_version":2,"outputs":[{"kind":"media","path":root.join("movie.mkv"),"state":"running","error":null}]})).unwrap();
        store.repository.tasks.lock().unwrap().push(task.clone());
        crate::repository::save_store(&store.repository).unwrap();
        (root, store, task, part)
    }

    fn persisted(root: &Path) -> serde_json::Value {
        serde_json::from_slice(&fs::read(root.join("tasks.json")).unwrap()).unwrap()
    }

    #[test]
    fn work_file_sits_beside_the_output_and_keeps_its_extension() {
        let dir = Path::new("downloads");
        assert_eq!(publish_work_path(&dir.join("movie.en.vtt"), "abc"), dir.join("movie.en.streamfirefly-part-abc.vtt"));
        assert_eq!(publish_work_path(&dir.join("movie"), "abc"), dir.join("movie.streamfirefly-part-abc"));
    }

    #[test]
    fn publish_moves_work_file_and_saves_success() {
        let (root, store, task, part) = fixture();
        let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
        owner.publish("media", 0, &part, &root.join("movie.mkv")).unwrap();
        assert_eq!(fs::read(root.join("movie.mkv")).unwrap(), b"complete-media");
        assert!(!part.exists(), "published work file was left beside the output");
        let saved = persisted(&root);
        assert_eq!(saved["tasks"][0]["state"], "succeeded");
        assert_eq!(saved["tasks"][0]["checkpoint_state"], "recoverable");
        owner.finish(&root.join("work")).unwrap();
        assert!(!root.join("work").exists());
        assert_eq!(persisted(&root)["tasks"][0]["checkpoint_state"], "cleaned");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn late_conflict_keeps_existing_file_and_drops_work_file() {
        let (root, store, task, part) = fixture();
        fs::write(root.join("movie.mkv"), b"original").unwrap();
        let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
        assert_eq!(owner.publish("media", 0, &part, &root.join("movie.mkv")), Err("output_path_conflict"));
        assert_eq!(fs::read(root.join("movie.mkv")).unwrap(), b"original");
        assert!(!part.exists());
        assert_eq!(persisted(&root)["tasks"][0]["state"], "running");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn move_and_save_wait_for_the_task_map() {
        let (root, store, task, part) = fixture();
        let destination = root.join("movie.mkv");
        let held = store.repository.tasks.lock().unwrap();
        let (worker_store, worker_part, worker_destination) = (store.clone(), part.clone(), destination.clone());
        let (started, ready) = mpsc::channel();
        let worker = thread::spawn(move || {
            started.send(()).unwrap();
            HlsPublication::begin(&worker_store, None, &task.id).unwrap().publish("media", 0, &worker_part, &worker_destination)
        });
        ready.recv_timeout(Duration::from_secs(5)).unwrap();
        thread::sleep(Duration::from_millis(100));
        let moved_early = destination.exists();
        drop(held);
        worker.join().unwrap().unwrap();
        let published = fs::read(&destination).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(!moved_early, "output moved while shutdown held the task map");
        assert_eq!(published, b"complete-media");
    }

    #[test]
    fn completion_save_failure_retains_checkpoint() {
        let (root, store, task, _) = fixture();
        fs::create_dir(store.repository.path.with_extension("tmp")).unwrap();
        let result = {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            owner.finish(&root.join("work"))
        };
        let retained = root.join("work/checkpoint.json").exists();
        fs::remove_dir_all(root).unwrap();
        assert!(result.is_err());
        assert!(retained, "completion save failure deleted the checkpoint");
    }

    #[test]
    fn publication_save_failure_hands_the_file_back_to_its_work_path() {
        let (root, store, task, part) = fixture();
        fs::write(root.join("unrelated.mkv"), b"original").unwrap();
        fs::create_dir(store.repository.path.with_extension("tmp")).unwrap();
        let result = {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            owner.publish("media", 0, &part, &root.join("movie.mkv"))
        };
        assert_eq!(result, Err("task_store_write_failed"));
        assert!(!root.join("movie.mkv").exists());
        assert_eq!(fs::read(&part).unwrap(), b"complete-media");
        assert_eq!(fs::read(root.join("unrelated.mkv")).unwrap(), b"original");
        assert!(root.join("work/checkpoint.json").exists());
        assert_eq!(store.repository.tasks.lock().unwrap()[0].state, "running");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn eof_preserves_published_media_and_pending_subtitle_recovery() {
        let (root, store, task, part) = fixture();
        {
            let mut tasks = store.repository.tasks.lock().unwrap();
            let mut subtitle = tasks[0].outputs[0].clone();
            subtitle.kind = "subtitle".into();
            subtitle.state = "queued".into();
            subtitle.path = Some(root.join("movie.en.vtt").to_string_lossy().into_owned());
            tasks[0].outputs.push(subtitle);
            persist_tasks(&store.repository, &tasks).unwrap();
        }
        {
            let owner = HlsPublication::begin(&store, None, &task.id).unwrap();
            store.exiting.store(true, Ordering::SeqCst);
            owner.publish("media", 0, &part, &root.join("movie.mkv")).unwrap();
        }
        crate::protocol::shutdown_downloads(&store).unwrap();
        assert!(HlsPublication::begin(&store, None, &task.id).is_err());
        let persisted = persisted(&root);
        assert_eq!(persisted["tasks"][0]["outputs"][0]["state"], "succeeded");
        assert_eq!(persisted["tasks"][0]["outputs"][1]["state"], "queued");
        assert_ne!(persisted["tasks"][0]["state"], "succeeded");
        assert!(root.join("work/checkpoint.json").exists());
        assert!(!root.join("movie.en.vtt").exists());
        fs::remove_dir_all(root).unwrap();
    }
}
