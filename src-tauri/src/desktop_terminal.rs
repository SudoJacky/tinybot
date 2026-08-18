use crate::protocol::capability::{CapabilityPolicy, WorkerCapability};
use crate::tools::shell::{
    ShellProcessIdParams, ShellProcessInputParams, ShellProcessOutput, ShellProcessPollParams,
    ShellProcessResizeParams, ShellStartParams, WorkerShellRpc, WorkerShellRuntime,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::State;

pub(crate) type SharedDesktopTerminalRuntime = Arc<DesktopTerminalRuntime>;

#[derive(Debug)]
pub(crate) struct DesktopTerminalRuntime {
    processes: WorkerShellRuntime,
    terminals: Mutex<HashMap<String, DesktopTerminalRecord>>,
}

#[derive(Clone, Debug)]
struct DesktopTerminalRecord {
    owner_id: String,
    process_id: String,
    shell: DesktopTerminalShell,
    working_directory: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum DesktopTerminalShell {
    Powershell,
    Cmd,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTerminalCreateInput {
    terminal_id: String,
    shell: DesktopTerminalShell,
    working_directory: String,
    rows: u16,
    cols: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTerminalPollInput {
    terminal_id: String,
    cursor: u64,
    #[serde(default)]
    yield_time_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTerminalWriteInput {
    terminal_id: String,
    input: String,
    cursor: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTerminalResizeInput {
    terminal_id: String,
    rows: u16,
    cols: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DesktopTerminalIdInput {
    terminal_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopTerminalSnapshot {
    terminal_id: String,
    shell: DesktopTerminalShell,
    process_id: String,
    working_directory: String,
    status: String,
    running: bool,
    exit_code: Option<i32>,
    output: String,
    cursor: u64,
    truncated: bool,
    dropped_bytes: u64,
    failure: Option<String>,
}

impl DesktopTerminalRuntime {
    pub(crate) fn new() -> Self {
        Self {
            processes: WorkerShellRuntime::default(),
            terminals: Mutex::new(HashMap::new()),
        }
    }

    fn create(&self, input: DesktopTerminalCreateInput) -> Result<DesktopTerminalSnapshot, String> {
        let terminal_id = required_terminal_id(&input.terminal_id)?;
        let working_directory = PathBuf::from(&input.working_directory);
        let mut terminals = self
            .terminals
            .lock()
            .map_err(|_| "Sidecar terminal registry lock was poisoned".to_string())?;

        if let Some(record) = terminals.get(&terminal_id) {
            if record.shell != input.shell || record.working_directory != working_directory {
                return Err(format!(
                    "Sidecar terminal {terminal_id} already exists with a different configuration"
                ));
            }
            let output = self
                .rpc(record)
                .poll(ShellProcessPollParams {
                    process_id: record.process_id.clone(),
                    owner_id: Some(record.owner_id.clone()),
                    cursor: Some(0),
                    yield_time_ms: Some(0),
                })
                .map_err(|error| {
                    format!(
                        "Failed to read Sidecar terminal {terminal_id}: {}",
                        error.message
                    )
                })?;
            return Ok(snapshot(record, output));
        }

        let owner_id = format!("sidecar-terminal:{terminal_id}");
        let record_shell = input.shell;
        let rpc = terminal_rpc_for(&working_directory, self.processes.clone());
        let output = rpc
            .start(ShellStartParams {
                command: terminal_shell_command(input.shell)?.to_string(),
                working_dir: Some(".".to_string()),
                tty: Some(true),
                yield_time_ms: Some(20),
                rows: Some(input.rows.max(1)),
                cols: Some(input.cols.max(1)),
                owner_id: Some(owner_id.clone()),
                tool_call_id: Some(owner_id.clone()),
                cancellation: None,
            })
            .map_err(|error| {
                format!(
                    "Failed to start Sidecar terminal {terminal_id}: {}",
                    error.message
                )
            })?;
        let record = DesktopTerminalRecord {
            owner_id,
            process_id: output.process_id.clone(),
            shell: record_shell,
            working_directory,
        };
        let result = snapshot(&record, output);
        terminals.insert(terminal_id, record);
        Ok(result)
    }

    fn poll(&self, input: DesktopTerminalPollInput) -> Result<DesktopTerminalSnapshot, String> {
        let record = self.record(&input.terminal_id)?;
        let output = self
            .rpc(&record)
            .poll(ShellProcessPollParams {
                process_id: record.process_id.clone(),
                owner_id: Some(record.owner_id.clone()),
                cursor: Some(input.cursor),
                yield_time_ms: Some(input.yield_time_ms.unwrap_or(250).min(1_000)),
            })
            .map_err(|error| {
                format!(
                    "Failed to poll Sidecar terminal {}: {}",
                    input.terminal_id, error.message
                )
            })?;
        Ok(snapshot(&record, output))
    }

    fn write(&self, input: DesktopTerminalWriteInput) -> Result<DesktopTerminalSnapshot, String> {
        let record = self.record(&input.terminal_id)?;
        let output = self
            .rpc(&record)
            .write_stdin(ShellProcessInputParams {
                process_id: record.process_id.clone(),
                owner_id: Some(record.owner_id.clone()),
                input: input.input,
                cursor: Some(input.cursor),
                yield_time_ms: Some(0),
            })
            .map_err(|error| {
                format!(
                    "Failed to write to Sidecar terminal {}: {}",
                    input.terminal_id, error.message
                )
            })?;
        Ok(snapshot(&record, output))
    }

    fn resize(&self, input: DesktopTerminalResizeInput) -> Result<(), String> {
        let record = self.record(&input.terminal_id)?;
        self.rpc(&record)
            .resize(ShellProcessResizeParams {
                process_id: record.process_id.clone(),
                owner_id: Some(record.owner_id.clone()),
                rows: input.rows.max(1),
                cols: input.cols.max(1),
            })
            .map_err(|error| {
                format!(
                    "Failed to resize Sidecar terminal {}: {}",
                    input.terminal_id, error.message
                )
            })
    }

    fn terminate(&self, input: DesktopTerminalIdInput) -> Result<(), String> {
        let terminal_id = required_terminal_id(&input.terminal_id)?;
        let record = {
            let terminals = self
                .terminals
                .lock()
                .map_err(|_| "Sidecar terminal registry lock was poisoned".to_string())?;
            terminals.get(&terminal_id).cloned()
        };
        let Some(record) = record else {
            return Ok(());
        };
        self.rpc(&record)
            .terminate(ShellProcessIdParams {
                process_id: record.process_id.clone(),
                owner_id: Some(record.owner_id.clone()),
            })
            .map_err(|error| {
                format!(
                    "Failed to terminate Sidecar terminal {terminal_id}: {}",
                    error.message
                )
            })?;
        self.processes
            .release(&record.process_id, Some(&record.owner_id))
            .map_err(|error| {
                format!(
                    "Failed to release Sidecar terminal {terminal_id}: {}",
                    error.message
                )
            })?;
        let mut terminals = self
            .terminals
            .lock()
            .map_err(|_| "Sidecar terminal registry lock was poisoned".to_string())?;
        if terminals
            .get(&terminal_id)
            .is_some_and(|current| current.process_id == record.process_id)
        {
            terminals.remove(&terminal_id);
        }
        Ok(())
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let report = self.processes.shutdown();
        self.terminals
            .lock()
            .map_err(|_| "Sidecar terminal registry lock was poisoned".to_string())?
            .clear();
        if report.failures.is_empty() {
            Ok(())
        } else {
            Err(format!(
                "Failed to terminate Sidecar terminal processes: {}",
                report.failures.join("; ")
            ))
        }
    }

    fn record(&self, terminal_id: &str) -> Result<DesktopTerminalRecord, String> {
        let terminal_id = required_terminal_id(terminal_id)?;
        self.terminals
            .lock()
            .map_err(|_| "Sidecar terminal registry lock was poisoned".to_string())?
            .get(&terminal_id)
            .cloned()
            .ok_or_else(|| format!("Unknown Sidecar terminal {terminal_id}"))
    }

    fn rpc(&self, record: &DesktopTerminalRecord) -> WorkerShellRpc {
        terminal_rpc_for(&record.working_directory, self.processes.clone())
    }
}

pub(crate) fn create_runtime() -> SharedDesktopTerminalRuntime {
    Arc::new(DesktopTerminalRuntime::new())
}

#[tauri::command]
pub(crate) async fn terminal_create(
    input: DesktopTerminalCreateInput,
    runtime: State<'_, SharedDesktopTerminalRuntime>,
) -> Result<DesktopTerminalSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.create(input))
        .await
        .map_err(|error| format!("Sidecar terminal create task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn terminal_poll(
    input: DesktopTerminalPollInput,
    runtime: State<'_, SharedDesktopTerminalRuntime>,
) -> Result<DesktopTerminalSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.poll(input))
        .await
        .map_err(|error| format!("Sidecar terminal poll task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn terminal_write(
    input: DesktopTerminalWriteInput,
    runtime: State<'_, SharedDesktopTerminalRuntime>,
) -> Result<DesktopTerminalSnapshot, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.write(input))
        .await
        .map_err(|error| format!("Sidecar terminal write task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn terminal_resize(
    input: DesktopTerminalResizeInput,
    runtime: State<'_, SharedDesktopTerminalRuntime>,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.resize(input))
        .await
        .map_err(|error| format!("Sidecar terminal resize task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn terminal_terminate(
    input: DesktopTerminalIdInput,
    runtime: State<'_, SharedDesktopTerminalRuntime>,
) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.terminate(input))
        .await
        .map_err(|error| format!("Sidecar terminal terminate task failed: {error}"))?
}

fn terminal_rpc_for(
    working_directory: &std::path::Path,
    runtime: WorkerShellRuntime,
) -> WorkerShellRpc {
    WorkerShellRpc::with_runtime(
        working_directory.to_path_buf(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
        runtime,
    )
}

fn snapshot(record: &DesktopTerminalRecord, output: ShellProcessOutput) -> DesktopTerminalSnapshot {
    DesktopTerminalSnapshot {
        terminal_id: output
            .owner_id
            .as_deref()
            .and_then(|owner| owner.strip_prefix("sidecar-terminal:"))
            .unwrap_or_default()
            .to_string(),
        shell: record.shell,
        process_id: output.process_id,
        working_directory: record.working_directory.to_string_lossy().into_owned(),
        status: output.status,
        running: output.running,
        exit_code: output.exit_code,
        output: output.output,
        cursor: output.cursor,
        truncated: output.truncated,
        dropped_bytes: output.dropped_bytes,
        failure: output.failure,
    }
}

fn required_terminal_id(value: &str) -> Result<String, String> {
    let terminal_id = value.trim();
    if terminal_id.is_empty() {
        return Err("Sidecar terminal ID is required".to_string());
    }
    Ok(terminal_id.to_string())
}

#[cfg(target_os = "windows")]
fn terminal_shell_command(shell: DesktopTerminalShell) -> Result<&'static str, String> {
    Ok(match shell {
        DesktopTerminalShell::Powershell => "powershell.exe -NoLogo",
        DesktopTerminalShell::Cmd => "cmd.exe /Q",
    })
}

#[cfg(not(target_os = "windows"))]
fn terminal_shell_command(_shell: DesktopTerminalShell) -> Result<&'static str, String> {
    Err("Sidecar terminal is currently supported only on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_terminal_ids() {
        assert_eq!(
            required_terminal_id("  ").expect_err("empty ID should be rejected"),
            "Sidecar terminal ID is required"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn creates_each_terminal_resource_only_once() {
        let runtime = DesktopTerminalRuntime::new();
        let input = DesktopTerminalCreateInput {
            terminal_id: "terminal:test:1".to_string(),
            shell: DesktopTerminalShell::Cmd,
            working_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            rows: 24,
            cols: 80,
        };

        let first = runtime
            .create(input.clone())
            .expect("terminal should start");
        let second = runtime
            .create(input)
            .expect("terminal create should be idempotent");

        assert_eq!(first.process_id, second.process_id);
        assert_eq!(first.terminal_id, "terminal:test:1");
        runtime
            .terminate(DesktopTerminalIdInput {
                terminal_id: "terminal:test:1".to_string(),
            })
            .expect("terminal should terminate");
    }
}
