use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ApprovedProgram {
    pub(crate) path: String,
    #[serde(rename = "approvedAt")]
    pub(crate) approved_at: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct ApprovedProgramsFile {
    #[serde(default)]
    version: u64,
    #[serde(default)]
    programs: Vec<ApprovedProgram>,
}

/// Key form used by the approval table: canonicalized (symlinks resolved),
/// `\\?\` prefix stripped, and case-insensitive on Windows. Approval and
/// invoke both normalize through this, so the same file matches either way.
fn normalize_key(text: &str) -> String {
    let stripped = text.strip_prefix("\\\\?\\").unwrap_or(text);
    #[cfg(windows)]
    {
        stripped.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        stripped.to_owned()
    }
}

pub(crate) fn normalize_program_path(raw: &str) -> Option<String> {
    let canonical = std::fs::canonicalize(raw).ok()?;
    Some(normalize_key(&canonical.to_string_lossy()))
}

pub(crate) struct Approvals {
    file: PathBuf,
    programs: HashMap<String, ApprovedProgram>,
}

impl Approvals {
    pub(crate) fn load(file: PathBuf) -> Self {
        let programs = std::fs::read_to_string(&file)
            .ok()
            .and_then(|text| serde_json::from_str::<ApprovedProgramsFile>(&text).ok())
            .map(|parsed| {
                parsed
                    .programs
                    .into_iter()
                    .map(|program| (program.path.clone(), program))
                    .collect()
            })
            .unwrap_or_default();
        Approvals { file, programs }
    }

    pub(crate) fn is_approved(&self, executable: &str) -> bool {
        normalize_program_path(executable)
            .map(|key| self.programs.contains_key(&key))
            .unwrap_or(false)
    }

    pub(crate) fn approve(&mut self, executable: &str) -> Result<ApprovedProgram, &'static str> {
        let key = normalize_program_path(executable).ok_or("executable_not_found")?;
        let program = ApprovedProgram {
            path: key.clone(),
            approved_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0),
        };
        self.programs.insert(key, program.clone());
        self.save()?;
        Ok(program)
    }

    pub(crate) fn revoke(&mut self, executable: &str) -> Result<(), &'static str> {
        // The file may have been deleted since approval; fall back to the
        // loose key form so the stale entry can still be removed.
        let key = match normalize_program_path(executable) {
            Some(key) => key,
            None => normalize_key(executable),
        };
        self.programs.remove(&key);
        self.save()
    }

    fn save(&self) -> Result<(), &'static str> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "approval_store_failed")?;
        }
        let file = ApprovedProgramsFile {
            version: 1,
            programs: self.programs.values().cloned().collect(),
        };
        let text = serde_json::to_string_pretty(&file).map_err(|_| "approval_store_failed")?;
        std::fs::write(&self.file, text).map_err(|_| "approval_store_failed")
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_key, Approvals};

    fn temp_store(name: &str) -> (TempDirGuard, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "streamfirefly-approvals-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let program = dir.join("Downloader.exe");
        std::fs::write(&program, b"test").unwrap();
        (TempDirGuard(dir.clone()), program)
    }

    struct TempDirGuard(std::path::PathBuf);
    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    impl std::ops::Deref for TempDirGuard {
        type Target = std::path::PathBuf;
        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    #[test]
    fn approve_persists_and_revoke_removes() {
        let (dir, program) = temp_store("roundtrip");
        let file = dir.join("approved_programs.json");
        let mut approvals = Approvals::load(file.clone());
        assert!(!approvals.is_approved(program.to_str().unwrap()));
        let stored = approvals.approve(program.to_str().unwrap()).unwrap();
        assert!(!stored.path.is_empty());
        assert!(approvals.is_approved(program.to_str().unwrap()));
        drop(approvals);
        // A fresh load from disk must remember the approval.
        let mut reloaded = Approvals::load(file.clone());
        assert!(reloaded.is_approved(program.to_str().unwrap()));
        reloaded.revoke(program.to_str().unwrap()).unwrap();
        assert!(!reloaded.is_approved(program.to_str().unwrap()));
        drop(reloaded);
        let cleared = Approvals::load(file);
        assert!(!cleared.is_approved(program.to_str().unwrap()));
    }

    #[test]
    fn unc_prefix_is_stripped_from_keys() {
        assert_eq!(normalize_key("\\\\?\\C:\\Tools\\X.exe"), "C:\\Tools\\X.exe");
    }

    #[cfg(windows)]
    #[test]
    fn windows_keys_are_case_insensitive() {
        assert_eq!(
            normalize_key("C:\\Tools\\X.exe"),
            normalize_key("c:\\tools\\x.exe")
        );
    }
}
