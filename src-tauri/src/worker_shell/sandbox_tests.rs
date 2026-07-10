use super::sandbox::{select_shell_sandbox, ShellSandboxAdapter};
use crate::worker_permission_profile::{PermissionNetworkMode, ShellSandboxMode};

#[test]
fn unrestricted_unsandboxed_shell_is_labeled_honestly() {
    let selection = select_shell_sandbox(
        ShellSandboxMode::Unsandboxed,
        PermissionNetworkMode::Unrestricted,
        false,
    )
    .expect("the explicit unsandboxed mode should remain available");

    assert_eq!(selection.adapter, ShellSandboxAdapter::Unsandboxed);
    assert_eq!(selection.sandbox_label, "unsandboxed_approved");
    assert_eq!(selection.network_label, "unrestricted");
}

#[test]
fn unavailable_network_enforcement_fails_closed() {
    for mode in [
        PermissionNetworkMode::Denied,
        PermissionNetworkMode::Configured,
    ] {
        let error = select_shell_sandbox(ShellSandboxMode::Unsandboxed, mode, false)
            .expect_err("an unavailable network adapter must not be reported as enforced");
        assert!(error.message.contains("network"));
        assert_eq!(error.details["enforced"], false);
        assert_eq!(error.details["processStarted"], false);
    }
}

#[test]
fn read_only_pty_fails_closed_before_process_start() {
    let error = select_shell_sandbox(
        ShellSandboxMode::ReadOnly,
        PermissionNetworkMode::Unrestricted,
        true,
    )
    .expect_err("read-only PTY execution is not implemented");

    assert!(error.message.contains("PTY"));
    assert_eq!(error.details["processStarted"], false);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_read_only_pipe_selects_the_restricted_token_adapter() {
    let selection = select_shell_sandbox(
        ShellSandboxMode::ReadOnly,
        PermissionNetworkMode::Unrestricted,
        false,
    )
    .expect("Windows should expose the restricted-token read-only adapter");

    assert_eq!(selection.adapter, ShellSandboxAdapter::WindowsReadOnly);
    assert_eq!(
        selection.sandbox_label,
        "windows_restricted_low_integrity_read_only"
    );
}

#[cfg(not(target_os = "windows"))]
#[test]
fn read_only_pipe_fails_closed_without_a_platform_adapter() {
    let error = select_shell_sandbox(
        ShellSandboxMode::ReadOnly,
        PermissionNetworkMode::Unrestricted,
        false,
    )
    .expect_err("unsupported platforms must not claim read-only enforcement");

    assert!(error.message.contains("platform adapter"));
    assert_eq!(error.details["processStarted"], false);
}
