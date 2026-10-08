use crate::capture_diagnostics::record;
use crate::capture_model::Session;
use crate::persistence::replace_file;
use crate::task_input::safe_file_stem;
use serde_json::json;
use std::fs::{self, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

/// Moves the merged files of a complete session next to its directory, named after the page.
/// A file that cannot be moved stays in the session directory under its original path.
pub(crate) fn export(session: &Session, outputs: Vec<String>) -> Vec<String> {
    let Some(parent) = session.directory.parent() else {
        return outputs;
    };
    let stem = session
        .snapshot
        .page_title
        .as_deref()
        .and_then(safe_file_stem)
        .unwrap_or_else(|| format!("capture-{}", session.snapshot.id.chars().take(8).collect::<String>()));
    let count = outputs.len();
    outputs
        .into_iter()
        .enumerate()
        .map(|(index, output)| {
            let name = if count > 1 { format!("{stem} - 片段{}", index + 1) } else { stem.clone() };
            match move_unique(Path::new(&output), parent, &name) {
                Ok(path) => path.to_string_lossy().into_owned(),
                Err(error) => {
                    record(session, "output-export", json!({"index":index,"error":error.to_string()}));
                    output
                }
            }
        })
        .collect()
}

fn move_unique(source: &Path, directory: &Path, stem: &str) -> io::Result<PathBuf> {
    for index in 0..1000 {
        let suffix = if index == 0 { String::new() } else { format!(" ({index})") };
        let candidate = directory.join(format!("{stem}{suffix}.mkv"));
        // Reserve the name first: replace_file overwrites, and two sessions may finish together.
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(file) => {
                drop(file);
                return match replace_file(source, &candidate) {
                    Ok(()) => Ok(candidate),
                    Err(error) => {
                        let _ = fs::remove_file(&candidate);
                        Err(error)
                    }
                };
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free output name"))
}

/// Exported outputs of a session: plain `.mkv` files directly beside its directory.
pub(crate) fn exported_outputs<'a>(directory: &Path, outputs: &'a [String]) -> Vec<&'a Path> {
    outputs
        .iter()
        .map(Path::new)
        .filter(|path| {
            path.parent() == directory.parent()
                && path.extension().is_some_and(|extension| extension.eq_ignore_ascii_case("mkv"))
        })
        .collect()
}

/// Deletes an exported output; a file already moved or deleted by the user is not an error.
pub(crate) fn remove_exported(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => fs::remove_file(path),
        Ok(_) => Err(io::Error::other("capture output is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture_model::Snapshot;
    use uuid::Uuid;

    fn session(root: &Path, title: Option<&str>) -> Session {
        let id = Uuid::new_v4().to_string();
        let directory = root.join(format!("capture-{id}"));
        fs::create_dir_all(&directory).unwrap();
        Session {
            snapshot: Snapshot {
                version: 1,
                id,
                state: "complete".into(),
                bytes: 0,
                tracks: Vec::new(),
                output: None,
                outputs: Vec::new(),
                error: None,
                created_at: 0,
                page_title: title.map(Into::into),
                page_url: None,
            },
            directory,
            stop: true,
            worker_active: false,
        }
    }

    fn merged(session: &Session, generation: u32) -> String {
        let path = session.directory.join(format!("capture-{generation}.mkv"));
        fs::write(&path, format!("media-{generation}")).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn moves_outputs_beside_the_directory_with_page_titles_and_unique_names() {
        let root = std::env::temp_dir().join(format!("capture-export-{}", Uuid::new_v4()));
        let first = session(&root, Some("第 1 集: 开始?"));
        let outputs = export(&first, vec![merged(&first, 0)]);
        assert_eq!(outputs, vec![root.join("第 1 集_ 开始_.mkv").to_string_lossy().into_owned()]);
        assert_eq!(fs::read(&outputs[0]).unwrap(), b"media-0");
        assert!(!first.directory.join("capture-0.mkv").exists());
        let second = session(&root, Some("第 1 集: 开始?"));
        let outputs = export(&second, vec![merged(&second, 0), merged(&second, 1)]);
        assert_eq!(
            outputs,
            vec![
                root.join("第 1 集_ 开始_ - 片段1.mkv").to_string_lossy().into_owned(),
                root.join("第 1 集_ 开始_ - 片段2.mkv").to_string_lossy().into_owned(),
            ]
        );
        let third = session(&root, Some("第 1 集: 开始?"));
        let outputs = export(&third, vec![merged(&third, 0)]);
        assert_eq!(outputs, vec![root.join("第 1 集_ 开始_ (1).mkv").to_string_lossy().into_owned()]);
        let untitled = session(&root, None);
        let outputs = export(&untitled, vec![merged(&untitled, 0)]);
        assert_eq!(
            outputs,
            vec![root.join(format!("capture-{}.mkv", &untitled.snapshot.id[..8])).to_string_lossy().into_owned()]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keeps_an_output_in_place_when_it_cannot_be_moved() {
        let root = std::env::temp_dir().join(format!("capture-export-{}", Uuid::new_v4()));
        let current = session(&root, Some("视频"));
        let missing = current.directory.join("capture-0.mkv").to_string_lossy().into_owned();
        assert_eq!(export(&current, vec![missing.clone()]), vec![missing]);
        assert!(!root.join("视频.mkv").exists());
        let records: serde_json::Value =
            serde_json::from_slice(&fs::read(current.directory.join("diagnostics.json")).unwrap()).unwrap();
        assert_eq!(records[0]["stage"], "output-export");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selects_only_mkv_files_beside_the_directory_for_removal() {
        let root = std::env::temp_dir().join(format!("capture-export-{}", Uuid::new_v4()));
        let current = session(&root, None);
        let outputs = vec![
            root.join("视频.mkv").to_string_lossy().into_owned(),
            current.directory.join("capture-0.mkv").to_string_lossy().into_owned(),
            root.join("视频.txt").to_string_lossy().into_owned(),
            std::env::temp_dir().join("视频.mkv").to_string_lossy().into_owned(),
        ];
        assert_eq!(exported_outputs(&current.directory, &outputs), vec![root.join("视频.mkv").as_path()]);
        fs::write(root.join("视频.mkv"), b"media").unwrap();
        remove_exported(&root.join("视频.mkv")).unwrap();
        assert!(!root.join("视频.mkv").exists());
        remove_exported(&root.join("视频.mkv")).unwrap();
        assert!(remove_exported(&current.directory).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
