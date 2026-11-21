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
    order: VecDeque<String>, // FIFO by insertion order
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

#[derive(Default)]
pub(crate) struct ProgramLauncher {
    requests: Mutex<Receipts>,
}

fn validate(payload: &Value) -> Result<(&str, Vec<&str>), &'static str> {
    let executable = payload["executable"]
        .as_str()
        .ok_or("executable_required")?;
    let path = Path::new(executable);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute()
        || executable.starts_with("\\\\")
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
    pub(crate) fn test(&self, payload: &Value) -> Result<Value, &'static str> {
        validate(payload)?;
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

    #[test]
    fn receipts_evict_in_fifo_order_and_stay_idempotent() {
        let mut receipts = Receipts::default();
        for index in 0..1001 {
            receipts.insert(format!("request-{index:04}"), json!({"seq": index}));
        }
        assert!(receipts.get("request-0000").is_none());
        assert_eq!(
            receipts.get("request-1000").map(|value| value["seq"].clone()),
            Some(json!(1000))
        );
        // Reading the oldest live receipt does not move it to the back.
        assert!(receipts.get("request-0001").is_some());
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
        let launcher = ProgramLauncher::default();
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
