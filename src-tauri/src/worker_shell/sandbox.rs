use super::shell_error;
use crate::worker_permission_profile::{PermissionNetworkMode, ShellSandboxMode};
use crate::worker_protocol::WorkerProtocolError;

#[cfg(target_os = "windows")]
pub(super) mod windows;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ShellSandboxAdapter {
    Unsandboxed,
    WindowsReadOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ShellSandboxSelection {
    pub(super) adapter: ShellSandboxAdapter,
    pub(super) sandbox_label: &'static str,
    pub(super) network_label: &'static str,
}

pub(super) fn select_shell_sandbox(
    sandbox_mode: ShellSandboxMode,
    network_mode: PermissionNetworkMode,
    tty: bool,
) -> Result<ShellSandboxSelection, WorkerProtocolError> {
    if network_mode != PermissionNetworkMode::Unrestricted {
        return Err(shell_error(
            "requested shell network enforcement is unavailable",
            serde_json::json!({
                "sandboxMode": sandbox_mode,
                "networkMode": network_mode,
                "enforced": false,
                "processStarted": false,
            }),
        ));
    }

    match sandbox_mode {
        ShellSandboxMode::Unsandboxed => Ok(ShellSandboxSelection {
            adapter: ShellSandboxAdapter::Unsandboxed,
            sandbox_label: "unsandboxed_approved",
            network_label: "unrestricted",
        }),
        ShellSandboxMode::ReadOnly if tty => Err(shell_error(
            "read-only shell PTY enforcement is unavailable",
            serde_json::json!({
                "sandboxMode": sandbox_mode,
                "networkMode": network_mode,
                "tty": true,
                "enforced": false,
                "processStarted": false,
            }),
        )),
        ShellSandboxMode::ReadOnly => select_read_only_pipe(network_mode),
    }
}

#[cfg(target_os = "windows")]
fn select_read_only_pipe(
    _network_mode: PermissionNetworkMode,
) -> Result<ShellSandboxSelection, WorkerProtocolError> {
    Ok(ShellSandboxSelection {
        adapter: ShellSandboxAdapter::WindowsReadOnly,
        sandbox_label: "windows_restricted_low_integrity_read_only",
        network_label: "unrestricted",
    })
}

#[cfg(not(target_os = "windows"))]
fn select_read_only_pipe(
    network_mode: PermissionNetworkMode,
) -> Result<ShellSandboxSelection, WorkerProtocolError> {
    Err(shell_error(
        "read-only shell platform adapter is unavailable",
        serde_json::json!({
            "sandboxMode": ShellSandboxMode::ReadOnly,
            "networkMode": network_mode,
            "enforced": false,
            "processStarted": false,
        }),
    ))
}
