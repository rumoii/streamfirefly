use serde_json::{json, Value};
use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

const RECEIPT_LIMIT: usize = 1000;

#[derive(Default)]
struct Receipts {
    map: HashMap<String, Value>,
    order: VecDeque<String>,
}

impl Receipts {
    fn get(&self, id: &str) -> Option<&Value> {
        self.map.get(id)
    }

    fn insert(&mut self, id: String, receipt: Value) {
        if !self.map.contains_key(&id) {
            self.order.push_back(id.clone());
        }
        self.map.insert(id, receipt);
        while self.order.len() > RECEIPT_LIMIT {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }
}

pub(crate) struct ProgramLauncher {
    requests: Mutex<Receipts>,
    approvals: Mutex<crate::approvals::Approvals>,
}

impl ProgramLauncher {
    pub(crate) fn new(approvals_file: std::path::PathBuf) -> Self {
        ProgramLauncher {
            requests: Mutex::new(Receipts::default()),
            approvals: Mutex::new(crate::approvals::Approvals::load(approvals_file)),
        }
    }
}

fn validate_executable(executable: &str) -> Result<(), &'static str> {
    let path = Path::new(executable);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extended_local = executable
        .strip_prefix("\\\\?\\")
        .map(|path| {
            let bytes = path.as_bytes();
            bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && matches!(bytes[2], b'\\' | b'/')
        })
        .unwrap_or(false);
    if !path.is_absolute()
        || (executable.starts_with("\\\\") && !extended_local)
        || !name.ends_with(".exe")
        || executable.len() > 4096
        || executable.contains(['\0', '\r', '\n'])
    {
        return Err("executable_path_invalid");
    }
    if [
        "cmd.exe",
        "powershell.exe",
        "powershell_ise.exe",
        "pwsh.exe",
        "wscript.exe",
        "cscript.exe",
        "mshta.exe",
        "rundll32.exe",
        "regsvr32.exe",
        "node.exe",
        "python.exe",
        "pythonw.exe",
        "py.exe",
        "bash.exe",
        "sh.exe",
        "wsl.exe",
    ]
    .contains(&name.as_str())
    {
        return Err("script_interpreter_not_allowed");
    }
    if !path.is_file() {
        return Err("executable_not_found");
    }
    Ok(())
}

fn validate(payload: &Value) -> Result<(&str, Vec<&str>), &'static str> {
    let executable = payload["executable"]
        .as_str()
        .ok_or("executable_required")?;
    validate_executable(executable)?;
    let arguments = payload["arguments"]
        .as_array()
        .ok_or("arguments_required")?;
    if arguments.len() > 64 {
        return Err("arguments_too_large");
    }
    let mut result = Vec::new();
    let mut total = 0;
    for argument in arguments {
        let argument = argument.as_str().ok_or("argument_invalid")?;
        total += argument.len();
        if argument.contains(['\0', '\r', '\n']) || total > 16384 {
            return Err("argument_invalid");
        }
        result.push(argument);
    }
    Ok((executable, result))
}

impl ProgramLauncher {
    fn is_approved(&self, executable: &str) -> Result<bool, &'static str> {
        Ok(self
            .approvals
            .lock()
            .map_err(|_| "launcher_unavailable")?
            .is_approved(executable))
    }

    pub(crate) fn approve(&self, payload: &Value) -> Result<Value, &'static str> {
        let executable = payload["executable"]
            .as_str()
            .ok_or("executable_required")?;
        validate_executable(executable)?;
        let program = self
            .approvals
            .lock()
            .map_err(|_| "launcher_unavailable")?
            .approve(executable)?;
        Ok(json!({"state":"approved","path":program.path,"approvedAt":program.approved_at}))
    }

    pub(crate) fn revoke(&self, payload: &Value) -> Result<Value, &'static str> {
        let executable = payload["executable"]
            .as_str()
            .ok_or("executable_required")?;
        self.approvals
            .lock()
            .map_err(|_| "launcher_unavailable")?
            .revoke(executable)?;
        Ok(json!({"state":"revoked"}))
    }

    pub(crate) fn approval(&self, payload: &Value) -> Result<Value, &'static str> {
        let executable = payload["executable"]
            .as_str()
            .ok_or("executable_required")?;
        Ok(json!({"approved": self.is_approved(executable)?}))
    }

    pub(crate) fn test(&self, payload: &Value) -> Result<Value, &'static str> {
        let (executable, _) = validate(payload)?;
        if !self.is_approved(executable)? {
            return Err("program_not_approved");
        }
        Ok(json!({"state":"available"}))
    }

    pub(crate) fn invoke(&self, payload: &Value) -> Result<Value, &'static str> {
        let request_id = payload["requestId"]
            .as_str()
            .filter(|value| {
                value.len() >= 8
                    && value.len() <= 100
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
            })
            .ok_or("request_id_required")?;
        let mut requests = self.requests.lock().map_err(|_| "launcher_unavailable")?;
        if let Some(receipt) = requests.get(request_id) {
            return Ok(receipt.clone());
        }
        let (executable, arguments) = validate(payload)?;
        if !self.is_approved(executable)? {
            return Err("program_not_approved");
        }
        let mut command = Command::new(executable);
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let child = command.spawn().map_err(|_| "executable_start_failed")?;
        let pid = child.id();
        let child = Arc::new(Mutex::new(child));
        let waiting = child.clone();
        if std::thread::Builder::new()
            .name("external-program-wait".into())
            .spawn(move || {
                if let Ok(mut child) = waiting.lock() {
                    let _ = child.wait();
                }
            })
            .is_err()
        {
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err("executable_supervision_failed");
        }
        let receipt = json!({"state":"started","pid":pid});
        requests.insert(request_id.to_owned(), receipt.clone());
        Ok(receipt)
    }
}

#[cfg(test)]
mod tests {
    use super::{validate, ProgramLauncher, Receipts};
    use serde_json::json;

    fn test_launcher(name: &str) -> (PathGuard, ProgramLauncher) {
        let dir = std::env::temp_dir().join(format!(
            "streamfirefly-launcher-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("approved_programs.json");
        (
            PathGuard(dir),
            ProgramLauncher::new(file),
        )
    }

    struct PathGuard(std::path::PathBuf);
    impl Drop for PathGuard {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn program_requires_approval_until_revoked() {
        let (_guard, launcher) = test_launcher("approval");
        // Use a real .exe-named file for the flow checks.
        let program_path = _guard.0.join("Downloader.exe");
        std::fs::write(&program_path, b"test").unwrap();
        let program = program_path.to_str().unwrap().to_owned();
        let payload = json!({"executable": program, "arguments": []});
        assert_eq!(launcher.test(&payload), Err("program_not_approved"));
        assert_eq!(
            launcher.invoke(&json!({"requestId":"request-approval-1","executable":program,"arguments":[]})),
            Err("program_not_approved")
        );
        assert_eq!(launcher.approval(&payload).unwrap()["approved"], json!(false));
        assert_eq!(launcher.approve(&json!({"executable": program})).unwrap()["state"], json!("approved"));
        assert_eq!(launcher.approval(&payload).unwrap()["approved"], json!(true));
        assert_eq!(launcher.test(&payload).unwrap()["state"], json!("available"));
        assert_eq!(launcher.revoke(&json!({"executable": program})).unwrap()["state"], json!("revoked"));
        assert_eq!(launcher.test(&payload), Err("program_not_approved"));
    }

    #[test]
    fn approve_rejects_invalid_or_missing_programs() {
        let (_guard, launcher) = test_launcher("approve-invalid");
        assert_eq!(
            launcher.approve(&json!({"executable": "tool.exe"})),
            Err("executable_path_invalid")
        );
        let missing = _guard.0.join("Missing.exe");
        let missing = missing.to_str().unwrap().to_owned();
        assert_eq!(
            launcher.approve(&json!({"executable": missing})),
            Err("executable_not_found")
        );
        assert!(launcher.approve(&json!({})).is_err());
    }

    #[test]
    fn failed_approval_write_keeps_public_invoke_denied() {
        let (_guard, launcher) = test_launcher("failed-approval-invoke");
        let program = _guard.0.join("Downloader.exe");
        std::fs::write(&program, b"test").unwrap();
        std::fs::create_dir(_guard.0.join("approved_programs.json")).unwrap();
        let program = program.to_str().unwrap();
        assert!(matches!(
            launcher.approve(&json!({"executable": program})),
            Err("approval_store_failed")
        ));
        assert_eq!(
            launcher.invoke(&json!({"requestId":"failed-approval-invoke","executable":program,"arguments":[]})),
            Err("program_not_approved")
        );
    }

    #[test]
    fn revoke_deleted_alias_prevents_invoke_after_recreation() {
        let (_guard, launcher) = test_launcher("deleted-alias-invoke");
        let program = _guard.0.join("Downloader.exe");
        std::fs::write(&program, b"test").unwrap();
        let nested = _guard.0.join("nested");
        std::fs::create_dir(&nested).unwrap();
        let alias = nested.join("..").join("Downloader.exe");
        let alias = alias.to_str().unwrap();
        launcher.approve(&json!({"executable": alias})).unwrap();
        std::fs::remove_file(&program).unwrap();
        launcher.revoke(&json!({"executable": alias})).unwrap();
        std::fs::write(&program, b"recreated").unwrap();
        assert_eq!(
            launcher.invoke(&json!({"requestId":"deleted-alias-invoke","executable":alias,"arguments":[]})),
            Err("program_not_approved")
        );
    }

    #[cfg(windows)]
    #[test]
    fn extended_local_path_matches_regular_approval_through_public_entry_points() {
        let (_guard, launcher) = test_launcher("extended-path");
        let canonical = std::fs::canonicalize(std::env::current_exe().unwrap())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let regular = canonical.strip_prefix("\\\\?\\").unwrap_or(&canonical);
        let extended = format!("\\\\?\\{regular}");
        launcher
            .approve(&json!({"executable": regular}))
            .unwrap();
        assert_eq!(
            launcher.approval(&json!({"executable": extended})).unwrap()["approved"],
            json!(true)
        );
        assert_eq!(
            launcher
                .test(&json!({"executable": extended, "arguments": []}))
                .unwrap()["state"],
            json!("available")
        );
        assert_eq!(
            launcher.approve(&json!({"executable": "\\\\?\\UNC\\server\\share\\Downloader.exe"})),
            Err("executable_path_invalid")
        );
        assert_eq!(
            launcher.approve(&json!({"executable": "\\\\server\\share\\Downloader.exe"})),
            Err("executable_path_invalid")
        );
    }

    #[test]
    fn receipts_evict_oldest_beyond_limit_and_stay_idempotent() {
        let mut receipts = Receipts::default();
        for index in 0..1001 {
            receipts.insert(format!("request-{index:04}"), json!({"seq": index}));
        }
        assert!(receipts.get("request-0000").is_none());
        assert_eq!(
            receipts.get("request-1000").map(|value| value["seq"].clone()),
            Some(json!(1000))
        );
        receipts.insert("request-1001".into(), json!({"seq": 1001}));
        assert!(receipts.get("request-0001").is_none());
        // Re-inserting a live requestId must not duplicate its queue slot.
        let first = receipts.get("request-1001").cloned().unwrap();
        receipts.insert("request-1001".into(), json!({"seq": 1001}));
        assert_eq!(receipts.order.iter().filter(|id| *id == "request-1001").count(), 1);
        assert_eq!(receipts.get("request-1001"), Some(&first));
    }

    #[test]
    fn rejects_relative_paths_interpreters_and_invalid_arguments() {
        let (_guard, launcher) = test_launcher("validate");
        assert!(launcher
            .test(&json!({"executable":"tool.exe","arguments":[]}))
            .is_err());
        #[cfg(windows)]
        assert_eq!(
            validate(&json!({"executable":"C:\\Windows\\System32\\cmd.exe","arguments":[]})),
            Err("script_interpreter_not_allowed")
        );
        let executable = std::env::current_exe().unwrap();
        assert_eq!(
            launcher.test(&json!({"executable":executable,"arguments":["bad\nargument"]})),
            Err("argument_invalid")
        );
    }
}
