use serde::Serialize;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{State, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize)]
struct DesktopStatus {
    app_name: &'static str,
    gateway_http: &'static str,
    gateway_ws: &'static str,
    browser_mode: &'static str,
}

#[tauri::command]
fn desktop_status() -> DesktopStatus {
    DesktopStatus {
        app_name: "Tinybot Desktop",
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        browser_mode: "External browser",
    }
}

type SharedGateway = Arc<Mutex<GatewayRuntime>>;

struct GatewayRuntime {
    child: Option<Child>,
    logs: VecDeque<String>,
    last_error: Option<String>,
    keep_background: bool,
}

impl Default for GatewayRuntime {
    fn default() -> Self {
        Self {
            child: None,
            logs: VecDeque::with_capacity(200),
            last_error: None,
            keep_background: false,
        }
    }
}

#[derive(Serialize)]
struct GatewayRuntimeStatus {
    state: String,
    owner: String,
    http_ok: bool,
    gateway_http: &'static str,
    gateway_ws: &'static str,
    command: &'static str,
    repo_root: String,
    logs: Vec<String>,
    last_error: Option<String>,
}

#[tauri::command]
fn gateway_status(state: State<'_, SharedGateway>) -> GatewayRuntimeStatus {
    current_status(state.inner())
}

#[tauri::command]
fn start_gateway(state: State<'_, SharedGateway>) -> Result<GatewayRuntimeStatus, String> {
    if gateway_http_ok() {
        push_log(state.inner(), "gateway already reachable; treating process as external");
        return Ok(current_status(state.inner()));
    }

    let repo_root = repo_root();
    let mut command = Command::new("uv");
    command
        .args(["run", "tinybot", "gateway"])
        .current_dir(&repo_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start gateway: {error}"))?;

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, "stdout", state.inner().clone());
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, "stderr", state.inner().clone());
    }

    {
        let mut runtime = lock_runtime(state.inner());
        runtime.child = Some(child);
        runtime.last_error = None;
        append_log(&mut runtime, "started shell-owned gateway with `uv run tinybot gateway`");
    }

    Ok(current_status(state.inner()))
}

#[tauri::command]
fn stop_gateway(state: State<'_, SharedGateway>) -> Result<GatewayRuntimeStatus, String> {
    stop_owned_gateway(state.inner(), true)?;
    Ok(current_status(state.inner()))
}

fn current_status(shared: &SharedGateway) -> GatewayRuntimeStatus {
    let http_ok = gateway_http_ok();
    let mut runtime = lock_runtime(shared);
    let child_running = match runtime.child.as_mut() {
        Some(child) => match child.try_wait() {
            Ok(Some(status)) => {
                runtime.last_error = Some(format!("gateway exited with {status}"));
                runtime.child = None;
                false
            }
            Ok(None) => true,
            Err(error) => {
                runtime.last_error = Some(format!("failed to inspect gateway process: {error}"));
                false
            }
        },
        None => false,
    };

    let owner = if child_running {
        "shell"
    } else if http_ok {
        "external"
    } else {
        "none"
    };
    let state = if http_ok {
        "running"
    } else if child_running {
        "starting"
    } else {
        "offline"
    };

    GatewayRuntimeStatus {
        state: state.to_string(),
        owner: owner.to_string(),
        http_ok,
        gateway_http: "http://127.0.0.1:18790",
        gateway_ws: "ws://127.0.0.1:18790/ws",
        command: "uv run tinybot gateway",
        repo_root: repo_root().display().to_string(),
        logs: runtime.logs.iter().cloned().collect(),
        last_error: runtime.last_error.clone(),
    }
}

fn gateway_http_ok() -> bool {
    let addr: SocketAddr = match "127.0.0.1:18790".parse() {
        Ok(addr) => addr,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(700)) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(700)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(700)));
    if stream
        .write_all(b"GET /webui/bootstrap HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut first_line = String::new();
    let mut reader = BufReader::new(stream);
    if reader.read_line(&mut first_line).is_err() {
        return false;
    }
    first_line.split_whitespace().nth(1).is_some_and(|code| {
        code.parse::<u16>()
            .map(|status| (200..300).contains(&status))
            .unwrap_or(false)
    })
}

fn stop_owned_gateway(shared: &SharedGateway, explicit: bool) -> Result<(), String> {
    let child = {
        let mut runtime = lock_runtime(shared);
        if !explicit && runtime.keep_background {
            append_log(&mut runtime, "leaving shell-owned gateway running in background");
            return Ok(());
        }
        runtime.child.take()
    };

    if let Some(mut child) = child {
        terminate_child_process_tree(&mut child)
            .map_err(|error| format!("failed to stop gateway: {error}"))?;
        let _ = child.wait();
        let mut runtime = lock_runtime(shared);
        append_log(&mut runtime, "stopped shell-owned gateway");
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn terminate_child_process_tree(child: &mut Child) -> std::io::Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .creation_flags(0x08000000)
        .status();
    match status {
        Ok(status) if status.success() => Ok(()),
        _ => child.kill(),
    }
}

#[cfg(not(target_os = "windows"))]
fn terminate_child_process_tree(child: &mut Child) -> std::io::Result<()> {
    child.kill()
}

fn spawn_log_reader<R>(reader: R, label: &'static str, shared: SharedGateway)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines().map_while(Result::ok) {
            push_log(&shared, &format!("{label}: {line}"));
        }
    });
}

fn push_log(shared: &SharedGateway, line: &str) {
    let mut runtime = lock_runtime(shared);
    append_log(&mut runtime, line);
}

fn append_log(runtime: &mut GatewayRuntime, line: &str) {
    if runtime.logs.len() >= 200 {
        runtime.logs.pop_front();
    }
    runtime.logs.push_back(line.to_string());
}

fn lock_runtime(shared: &SharedGateway) -> std::sync::MutexGuard<'_, GatewayRuntime> {
    shared.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let gateway_state = Arc::new(Mutex::new(GatewayRuntime::default()));
    let close_state = gateway_state.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(gateway_state)
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            gateway_status,
            start_gateway,
            stop_gateway
        ])
        .on_window_event(move |_window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let _ = stop_owned_gateway(&close_state, false);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_shutdown_stops_shell_owned_gateway_child() {
        let child = spawn_long_running_child();
        let shared = Arc::new(Mutex::new(GatewayRuntime {
            child: Some(child),
            logs: VecDeque::with_capacity(200),
            last_error: None,
            keep_background: false,
        }));

        stop_owned_gateway(&shared, false).expect("shell-owned gateway child should stop");

        let runtime = lock_runtime(&shared);
        assert!(runtime.child.is_none());
        assert!(runtime.logs.iter().any(|line| line == "stopped shell-owned gateway"));
    }

    #[cfg(target_os = "windows")]
    fn spawn_long_running_child() -> Child {
        Command::new("cmd")
            .args(["/C", "ping", "-n", "30", "127.0.0.1", ">", "NUL"])
            .creation_flags(0x08000000)
            .spawn()
            .expect("test child process should start")
    }

    #[cfg(not(target_os = "windows"))]
    fn spawn_long_running_child() -> Child {
        Command::new("sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .expect("test child process should start")
    }
}
