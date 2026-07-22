use super::*;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Barrier};
use std::time::Duration;

#[test]
fn unavailable_network_policy_stops_before_process_creation() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let marker = fixture.root.join("network-policy-started.txt");

    let error = rpc
        .execute(ShellExecuteParams {
            command: create_marker_command("network-policy-started.txt"),
            working_dir: Some(".".to_string()),
            timeout: Some(10),
            restrict_to_workspace: Some(true),
            sandbox_mode: Some(ShellSandboxMode::Unsandboxed),
            network_mode: Some(PermissionNetworkMode::Denied),
            cancellation: None,
        })
        .expect_err("unsupported network denial must fail closed");

    assert!(error.message.contains("network"));
    assert_eq!(error.details["processStarted"], false);
    assert!(!marker.exists());
    assert_eq!(rpc.active_process_count(), 0);
}

#[cfg(target_os = "windows")]
#[test]
fn windows_read_only_process_reads_workspace_and_denies_writes() {
    use std::os::windows::process::CommandExt;

    let fixture = ProcessFixture::new();
    std::fs::write(fixture.root.join("readable.txt"), "readable-content")
        .expect("read-only fixture should be written before sandbox start");
    let world_writable = fixture.root.join("world-writable");
    std::fs::create_dir(&world_writable).expect("world-writable fixture directory should exist");
    let acl_status = std::process::Command::new("icacls")
        .arg(&world_writable)
        .args(["/grant", "*S-1-1-0:(OI)(CI)F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(0x08000000)
        .status()
        .expect("icacls should configure the test fixture");
    assert!(acl_status.success(), "icacls failed with {acl_status}");
    let rpc = shell_rpc(&fixture);

    let result = rpc
        .execute(ShellExecuteParams {
            command: "type readable.txt & echo blocked>world-writable\\blocked.txt".to_string(),
            working_dir: Some(".".to_string()),
            timeout: Some(10),
            restrict_to_workspace: Some(true),
            sandbox_mode: Some(ShellSandboxMode::ReadOnly),
            network_mode: Some(PermissionNetworkMode::Unrestricted),
            cancellation: None,
        })
        .expect("read-only shell process should start and report command failure");

    assert!(result.stdout.contains("readable-content"), "{result:?}");
    assert_ne!(result.exit_code, 0, "{result:?}");
    assert!(!world_writable.join("blocked.txt").exists(), "{result:?}");
    assert_eq!(
        result.sandbox_mode,
        "windows_restricted_low_integrity_read_only"
    );
    assert_eq!(result.network_mode, "unrestricted");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_read_only_process_preserves_a_quoted_absolute_path() {
    let fixture = ProcessFixture::new();
    std::fs::write(fixture.root.join("listed-read-only.txt"), "listed")
        .expect("read-only quoted path fixture should be written");
    let rpc = shell_rpc(&fixture);

    let result = rpc
        .execute(ShellExecuteParams {
            command: format!(r#"dir /B "{}""#, fixture.root.display()),
            working_dir: Some(".".to_string()),
            timeout: Some(10),
            restrict_to_workspace: Some(true),
            sandbox_mode: Some(ShellSandboxMode::ReadOnly),
            network_mode: Some(PermissionNetworkMode::Unrestricted),
            cancellation: None,
        })
        .expect("read-only quoted dir command should execute");

    assert_eq!(result.exit_code, 0, "{result:?}");
    assert!(result.stdout.contains("listed-read-only.txt"), "{result:?}");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_read_only_job_terminates_descendant_processes() {
    use std::os::windows::process::CommandExt;

    let fixture = ProcessFixture::new();
    let low_integrity = fixture.root.join("low-integrity");
    std::fs::create_dir(&low_integrity).expect("low-integrity fixture directory should exist");
    for arguments in [
        vec!["/grant", "*S-1-1-0:(OI)(CI)F"],
        vec!["/setintegritylevel", "(OI)(CI)L"],
    ] {
        let status = std::process::Command::new("icacls")
            .arg(&low_integrity)
            .args(arguments)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(0x08000000)
            .status()
            .expect("icacls should configure the low-integrity fixture");
        assert!(status.success(), "icacls failed with {status}");
    }
    let rpc = shell_rpc(&fixture);
    let probe = rpc
        .execute(ShellExecuteParams {
            command: "echo writable>low-integrity\\probe.txt".to_string(),
            working_dir: Some(".".to_string()),
            timeout: Some(10),
            restrict_to_workspace: Some(true),
            sandbox_mode: Some(ShellSandboxMode::ReadOnly),
            network_mode: Some(PermissionNetworkMode::Unrestricted),
            cancellation: None,
        })
        .expect("low-integrity write probe should execute");
    assert_eq!(probe.exit_code, 0, "{probe:?}");
    assert!(low_integrity.join("probe.txt").exists(), "{probe:?}");

    let started = rpc
        .start(ShellStartParams {
            command: concat!(
                "start \"\" /B cmd /D /S /C ",
                "\"choice /T 2 /D Y >nul & ",
                "echo survived>low-integrity\\child-survived.txt\" & ",
                "for /L %i in (0,0,1) do @rem"
            )
            .to_string(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: Some(ShellSandboxMode::ReadOnly),
            network_mode: Some(PermissionNetworkMode::Unrestricted),
            run_id: Some("run-read-only-job".to_string()),
            tool_call_id: Some("tool-read-only-job".to_string()),
            cancellation: None,
        })
        .expect("read-only process tree should start");
    assert!(started.running, "{started:?}");

    let terminated = rpc
        .terminate(ShellProcessIdParams {
            process_id: started.process_id,
            run_id: Some("run-read-only-job".to_string()),
        })
        .expect("read-only job should terminate");
    assert_eq!(terminated.status, "terminated", "{terminated:?}");
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        !low_integrity.join("child-survived.txt").exists(),
        "a descendant escaped the kill-on-close job"
    );
}

#[cfg(target_os = "windows")]
#[test]
fn windows_unsandboxed_termination_stops_descendant_processes() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let child_started = fixture.root.join("unsandboxed-child-started.txt");
    let child_survived = fixture.root.join("unsandboxed-child-survived.txt");
    std::fs::write(
        fixture.root.join("unsandboxed-child.ps1"),
        concat!(
            "Set-Content -LiteralPath 'unsandboxed-child-started.txt' -Value 'started'\r\n",
            "Start-Sleep -Seconds 2\r\n",
            "Set-Content -LiteralPath 'unsandboxed-child-survived.txt' -Value 'survived'\r\n"
        ),
    )
    .expect("unsandboxed child fixture should be written");
    std::fs::write(
        fixture.root.join("unsandboxed-parent.ps1"),
        concat!(
            "$child = Start-Process -FilePath 'powershell.exe' ",
            "-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','unsandboxed-child.ps1' ",
            "-PassThru -WindowStyle Hidden\r\n",
            "Set-Content -LiteralPath 'unsandboxed-child-pid.txt' -Value $child.Id\r\n",
            "while ($true) { Start-Sleep -Seconds 1 }\r\n"
        ),
    )
    .expect("unsandboxed parent fixture should be written");
    let started = rpc
        .start(ShellStartParams {
            command: concat!(
                "powershell.exe -NoProfile -ExecutionPolicy Bypass ",
                "-File unsandboxed-parent.ps1"
            )
            .to_string(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: Some(ShellSandboxMode::Unsandboxed),
            network_mode: Some(PermissionNetworkMode::Unrestricted),
            run_id: Some("run-unsandboxed-tree".to_string()),
            tool_call_id: Some("tool-unsandboxed-tree".to_string()),
            cancellation: None,
        })
        .expect("unsandboxed process tree should start");
    assert!(started.running, "{started:?}");

    let child_start_deadline = std::time::Instant::now() + Duration::from_secs(2);
    while !child_started.exists() {
        assert!(
            std::time::Instant::now() < child_start_deadline,
            "unsandboxed descendant should start before termination"
        );
        std::thread::sleep(Duration::from_millis(10));
    }

    let terminated = rpc
        .terminate(ShellProcessIdParams {
            process_id: started.process_id,
            run_id: Some("run-unsandboxed-tree".to_string()),
        })
        .expect("unsandboxed process tree should terminate");
    assert_eq!(terminated.status, "terminated", "{terminated:?}");
    std::thread::sleep(Duration::from_secs(3));
    assert!(
        !child_survived.exists(),
        "an unsandboxed descendant escaped task-tree termination"
    );
}

#[test]
fn interactive_process_accepts_input_resizes_and_exits_cleanly() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let started = rpc
        .start(ShellStartParams {
            command: interactive_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(true),
            yield_time_ms: Some(50),
            rows: Some(24),
            cols: Some(80),
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-interactive-process".to_string()),
            tool_call_id: Some("tool-interactive-process".to_string()),
            cancellation: None,
        })
        .expect("interactive process should start");

    assert!(started.running);
    assert_eq!(started.status, "running");
    let mut transcript = started.output.clone();
    rpc.resize(ShellProcessResizeParams {
        process_id: started.process_id.clone(),
        run_id: Some("run-interactive-process".to_string()),
        rows: 32,
        cols: 100,
    })
    .expect("PTY process should resize");

    let mut output = rpc
        .write_stdin(ShellProcessInputParams {
            process_id: started.process_id.clone(),
            run_id: Some("run-interactive-process".to_string()),
            input: interactive_input().to_string(),
            cursor: Some(started.cursor),
            yield_time_ms: Some(2_000),
        })
        .expect("interactive input should be written");
    transcript.push_str(&output.output);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while output.running {
        if std::time::Instant::now() >= deadline {
            let complete_output = rpc
                .poll(ShellProcessPollParams {
                    process_id: started.process_id.clone(),
                    run_id: Some("run-interactive-process".to_string()),
                    cursor: Some(0),
                    yield_time_ms: Some(0),
                })
                .expect("interactive process should remain pollable");
            panic!(
                "interactive process should exit after input; latest={output:?}; complete={complete_output:?}"
            );
        }
        output = rpc
            .poll(ShellProcessPollParams {
                process_id: started.process_id.clone(),
                run_id: Some("run-interactive-process".to_string()),
                cursor: Some(output.cursor),
                yield_time_ms: Some(100),
            })
            .expect("interactive process should poll");
        transcript.push_str(&output.output);
    }

    assert_eq!(output.status, "exited");
    assert_eq!(output.exit_code, Some(0));
    assert!(
        transcript.contains(if cfg!(target_os = "windows") {
            "answer=hello"
        } else {
            "got:hello"
        }),
        "{transcript:?}; {output:?}"
    );
    assert_eq!(rpc.active_process_count(), 0);
}

#[test]
fn pipe_process_preserves_stdout_and_stderr_streams() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let output = rpc
        .start(ShellStartParams {
            command: stdout_stderr_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(2_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-pipe-process".to_string()),
            tool_call_id: Some("tool-pipe-process".to_string()),
            cancellation: None,
        })
        .expect("pipe process should complete");

    assert!(!output.running);
    assert_eq!(output.exit_code, Some(0));
    assert!(output.stdout.contains("stdout-line"), "{output:?}");
    assert!(output.stderr.contains("stderr-line"), "{output:?}");
    assert!(output.chunks.iter().any(|chunk| chunk.stream == "stdout"));
    assert!(output.chunks.iter().any(|chunk| chunk.stream == "stderr"));
}

#[cfg(target_os = "windows")]
#[test]
fn windows_pipe_process_preserves_a_quoted_absolute_path() {
    let fixture = ProcessFixture::new();
    std::fs::write(fixture.root.join("listed.txt"), "listed")
        .expect("quoted path fixture should be written");
    let rpc = shell_rpc(&fixture);
    let output = rpc
        .start(ShellStartParams {
            command: format!(r#"dir /B "{}""#, fixture.root.display()),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(2_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-quoted-absolute-path".to_string()),
            tool_call_id: Some("tool-quoted-absolute-path".to_string()),
            cancellation: None,
        })
        .expect("quoted dir command should complete");

    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert!(output.stdout.contains("listed.txt"), "{output:?}");
}

#[cfg(target_os = "windows")]
#[test]
fn windows_pipe_process_decodes_the_active_oem_code_page() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let output = rpc
        .start(ShellStartParams {
            command: "echo é".to_string(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(2_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-oem-output".to_string()),
            tool_call_id: Some("tool-oem-output".to_string()),
            cancellation: None,
        })
        .expect("OEM output command should complete");

    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert!(output.stdout.contains('é'), "{output:?}");
    assert!(!output.stdout.contains('�'), "{output:?}");
}

#[test]
fn unknown_process_poll_fails_explicitly() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let error = rpc
        .poll(ShellProcessPollParams {
            process_id: "process-missing".to_string(),
            run_id: Some("run-missing".to_string()),
            cursor: None,
            yield_time_ms: Some(0),
        })
        .expect_err("unknown process must not return an empty success");

    assert!(error.message.contains("unknown shell process id"));
    assert_eq!(error.details["processId"], "process-missing");
}

#[test]
fn retained_process_start_requires_run_and_tool_owners() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let error = rpc
        .start(ShellStartParams {
            command: stdout_stderr_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: None,
            tool_call_id: None,
            cancellation: None,
        })
        .expect_err("retained process must have an owner");

    assert!(error.message.contains("runId is required"));
    assert_eq!(rpc.active_process_count(), 0);
}

#[test]
fn writing_after_a_polled_process_exits_fails_explicitly() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let started = rpc
        .start(ShellStartParams {
            command: delayed_exit_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-exit-race".to_string()),
            tool_call_id: Some("tool-exit-race".to_string()),
            cancellation: None,
        })
        .expect("delayed process should start");
    assert!(started.running);

    let mut output = started;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while output.running {
        assert!(
            std::time::Instant::now() < deadline,
            "delayed process should exit"
        );
        output = rpc
            .poll(ShellProcessPollParams {
                process_id: output.process_id.clone(),
                run_id: Some("run-exit-race".to_string()),
                cursor: Some(output.cursor),
                yield_time_ms: Some(100),
            })
            .expect("delayed process should remain pollable");
    }

    let error = rpc
        .write_stdin(ShellProcessInputParams {
            process_id: output.process_id,
            run_id: Some("run-exit-race".to_string()),
            input: "late input".to_string(),
            cursor: Some(output.cursor),
            yield_time_ms: Some(0),
        })
        .expect_err("stdin after exit must not return an empty success");
    assert!(error.message.contains("already exited"));
    assert_eq!(error.details["status"], "exited");
}

#[test]
fn terminate_run_stops_every_owned_process() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let first = start_blocking_process(&rpc, "run-cleanup", "tool-cleanup-1");
    let second = start_blocking_process(&rpc, "run-cleanup", "tool-cleanup-2");
    assert!(first.running);
    assert!(second.running);
    assert_eq!(rpc.active_process_count(), 2);

    let report = rpc.terminate_run("run-cleanup");

    assert_eq!(report.requested_process_ids.len(), 2, "{report:?}");
    assert_eq!(report.terminated_process_ids.len(), 2, "{report:?}");
    assert!(report.failures.is_empty(), "{report:?}");
    assert_eq!(rpc.active_process_count(), 0);
    for process_id in [first.process_id, second.process_id] {
        let output = rpc
            .poll(ShellProcessPollParams {
                process_id,
                run_id: Some("run-cleanup".to_string()),
                cursor: Some(0),
                yield_time_ms: Some(0),
            })
            .expect("terminated process should retain its final snapshot");
        assert_eq!(output.status, "terminated", "{output:?}");
    }
}

#[test]
fn concurrent_termination_waits_for_one_verified_exit() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let started = start_blocking_process(&rpc, "run-concurrent-terminate", "tool-terminate");
    let barrier = Arc::new(Barrier::new(3));
    let mut handles = Vec::new();
    for _ in 0..2 {
        let rpc = rpc.clone();
        let barrier = barrier.clone();
        let process_id = started.process_id.clone();
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            rpc.terminate(ShellProcessIdParams {
                process_id,
                run_id: Some("run-concurrent-terminate".to_string()),
            })
        }));
    }
    barrier.wait();

    for handle in handles {
        let output = handle
            .join()
            .expect("termination thread should not panic")
            .expect("concurrent termination should succeed");
        assert!(!output.running, "{output:?}");
        assert_eq!(output.status, "terminated", "{output:?}");
    }
    assert_eq!(rpc.active_process_count(), 0);
}

#[test]
fn output_buffer_preserves_bounded_head_and_tail() {
    let fixture = ProcessFixture::new();
    let mut expected_output = Vec::with_capacity(1_200_008);
    expected_output.extend_from_slice(b"HEAD");
    expected_output.resize(1_200_004, b'x');
    expected_output.extend_from_slice(b"TAIL");
    std::fs::write(fixture.root.join("large-output.txt"), expected_output)
        .expect("large output fixture should be written");
    let rpc = shell_rpc(&fixture);
    let mut output = rpc
        .start(ShellStartParams {
            command: bounded_output_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(10_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-bounded-output".to_string()),
            tool_call_id: Some("tool-bounded-output".to_string()),
            cancellation: None,
        })
        .expect("large output process should start");
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while output.running {
        assert!(
            std::time::Instant::now() < deadline,
            "large output process should exit"
        );
        output = rpc
            .poll(ShellProcessPollParams {
                process_id: output.process_id.clone(),
                run_id: Some("run-bounded-output".to_string()),
                cursor: Some(0),
                yield_time_ms: Some(500),
            })
            .expect("large output process should poll");
    }

    assert!(output.truncated, "{output:?}");
    assert!(output.dropped_bytes > 0, "{output:?}");
    assert!(output.stdout.starts_with("HEAD"), "{output:?}");
    assert!(output.stdout.ends_with("TAIL"), "{output:?}");
    assert!(output.stdout.len() <= 1024 * 1024);
}

#[test]
fn cancellation_terminates_the_owned_process() {
    let metrics_before = crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let cancellation = Arc::new(TestCancellation::default());
    let started = rpc
        .start(ShellStartParams {
            command: blocking_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-cancel-process".to_string()),
            tool_call_id: Some("tool-cancel-process".to_string()),
            cancellation: Some(cancellation.clone()),
        })
        .expect("blocking process should start");
    assert!(started.running);

    cancellation.cancel();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut output = started;
    while output.running {
        assert!(
            std::time::Instant::now() < deadline,
            "cancelled process should terminate"
        );
        output = rpc
            .poll(ShellProcessPollParams {
                process_id: output.process_id.clone(),
                run_id: Some("run-cancel-process".to_string()),
                cursor: Some(output.cursor),
                yield_time_ms: Some(100),
            })
            .expect("cancelled process should remain pollable");
    }

    assert_eq!(output.status, "cancelled", "{output:?}");
    assert_eq!(rpc.active_process_count(), 0);
    let cleanup = rpc.shutdown();
    assert!(cleanup.failures.is_empty(), "{cleanup:?}");
    let metrics_after = crate::runtime::observability::global_agent_runtime_metrics().snapshot();
    assert!(
        metrics_after["counters"]["process.start.completed"]
            .as_u64()
            .unwrap_or_default()
            >= metrics_before["counters"]["process.start.completed"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
    assert!(
        metrics_after["counters"]["process.stop.completed"]
            .as_u64()
            .unwrap_or_default()
            >= metrics_before["counters"]["process.stop.completed"]
                .as_u64()
                .unwrap_or_default()
                .saturating_add(1)
    );
}

#[test]
fn shutdown_releases_terminal_process_records() {
    let fixture = ProcessFixture::new();
    let rpc = shell_rpc(&fixture);
    let output = rpc
        .start(ShellStartParams {
            command: stdout_stderr_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(2_000),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-shutdown".to_string()),
            tool_call_id: Some("tool-shutdown".to_string()),
            cancellation: None,
        })
        .expect("short process should complete");
    assert!(!output.running);
    assert_eq!(
        rpc.list(ShellProcessListParams {
            run_id: Some("run-shutdown".to_string())
        })
        .expect("terminal process should remain listed")
        .len(),
        1
    );

    let report = rpc.shutdown();

    assert!(report.failures.is_empty(), "{report:?}");
    assert!(rpc
        .list(ShellProcessListParams::default())
        .expect("shutdown process list should be readable")
        .is_empty());
    let error = rpc
        .start(ShellStartParams {
            command: stdout_stderr_command(),
            working_dir: Some(".".to_string()),
            restrict_to_workspace: Some(true),
            tty: Some(false),
            yield_time_ms: Some(0),
            rows: None,
            cols: None,
            sandbox_mode: None,
            network_mode: None,
            run_id: Some("run-after-shutdown".to_string()),
            tool_call_id: Some("tool-after-shutdown".to_string()),
            cancellation: None,
        })
        .expect_err("shutdown process manager must reject new starts");
    assert!(error.message.contains("shutting down"));
}

fn start_blocking_process(
    rpc: &WorkerShellRpc,
    run_id: &str,
    tool_call_id: &str,
) -> ShellProcessOutput {
    rpc.start(ShellStartParams {
        command: blocking_command(),
        working_dir: Some(".".to_string()),
        restrict_to_workspace: Some(true),
        tty: Some(false),
        yield_time_ms: Some(0),
        rows: None,
        cols: None,
        sandbox_mode: None,
        network_mode: None,
        run_id: Some(run_id.to_string()),
        tool_call_id: Some(tool_call_id.to_string()),
        cancellation: None,
    })
    .expect("blocking process should start")
}

fn shell_rpc(fixture: &ProcessFixture) -> WorkerShellRpc {
    WorkerShellRpc::new(
        fixture.root.clone(),
        CapabilityPolicy::new([WorkerCapability::ShellExecute]),
    )
}

#[cfg(target_os = "windows")]
fn create_marker_command(path: &str) -> String {
    format!("echo started>{path}")
}

#[cfg(not(target_os = "windows"))]
fn create_marker_command(path: &str) -> String {
    format!("printf started > {path}")
}

#[cfg(target_os = "windows")]
fn interactive_command() -> String {
    "set /p answer= & set answer".to_string()
}

#[cfg(not(target_os = "windows"))]
fn interactive_command() -> String {
    "IFS= read -r line; printf 'got:%s\\n' \"$line\"".to_string()
}

#[cfg(target_os = "windows")]
fn interactive_input() -> &'static str {
    "hello\n"
}

#[cfg(not(target_os = "windows"))]
fn interactive_input() -> &'static str {
    "hello\n"
}

#[cfg(target_os = "windows")]
fn stdout_stderr_command() -> String {
    "echo stdout-line & echo stderr-line 1>&2".to_string()
}

#[cfg(not(target_os = "windows"))]
fn stdout_stderr_command() -> String {
    "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2".to_string()
}

#[cfg(target_os = "windows")]
fn delayed_exit_command() -> String {
    "powershell -NoProfile -Command \"Start-Sleep -Milliseconds 100\"".to_string()
}

#[cfg(not(target_os = "windows"))]
fn delayed_exit_command() -> String {
    "sleep 0.1".to_string()
}

#[cfg(target_os = "windows")]
fn blocking_command() -> String {
    "for /L %i in (0,0,1) do @rem".to_string()
}

#[cfg(not(target_os = "windows"))]
fn blocking_command() -> String {
    "while true; do :; done".to_string()
}

#[cfg(target_os = "windows")]
fn bounded_output_command() -> String {
    "type large-output.txt".to_string()
}

#[cfg(not(target_os = "windows"))]
fn bounded_output_command() -> String {
    "cat large-output.txt".to_string()
}

#[derive(Default, Debug)]
struct TestCancellation {
    cancelled: AtomicBool,
}

impl TestCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }
}

impl WorkerRequestCancellation for TestCancellation {
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

struct ProcessFixture {
    root: PathBuf,
}

impl ProcessFixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-process-manager-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock should be after unix epoch")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("process fixture should create");
        Self { root }
    }
}

impl Drop for ProcessFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
