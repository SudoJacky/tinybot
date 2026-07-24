use super::*;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn request(turn_id: &str) -> StartAgentTurn {
    StartAgentTurn::new(turn_id, format!("session:{turn_id}"))
}

fn final_result(turn_id: &str) -> Value {
    serde_json::json!({
        "runtime": "rust",
        "turnId": turn_id,
        "sessionId": format!("session:{turn_id}"),
        "stopReason": "final_response",
        "finalContent": "done"
    })
}

fn wait_until(timeout: Duration, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !condition() {
        assert!(Instant::now() < deadline, "condition did not become true");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn completed_turn_releases_its_active_handle_and_records_one_terminal_outcome() {
    let runtime = TurnExecutionRuntime::new();
    let handle = runtime
        .start_blocking(request("turn-complete"), || {
            Ok(final_result("turn-complete"))
        })
        .expect("turn should start");

    let result = handle.wait().expect("turn should complete");
    let status = runtime
        .status("turn-complete")
        .expect("status should remain");

    assert_eq!(result["stopReason"], "final_response");
    assert_eq!(runtime.active_count(), 0);
    assert_eq!(runtime.draining_count(), 0);
    assert_eq!(status.phase, "completed");
    assert_eq!(status.terminal_outcome.as_deref(), Some("completed"));
    assert_eq!(status.late_results_ignored, 0);
}

#[test]
fn duplicate_active_turn_is_rejected() {
    let runtime = TurnExecutionRuntime::new();
    let (release_sender, release_receiver) = mpsc::channel();
    let handle = runtime
        .start_blocking(request("turn-duplicate"), move || {
            release_receiver.recv().expect("release should arrive");
            Ok(final_result("turn-duplicate"))
        })
        .expect("first turn should start");

    let error = runtime
        .start_blocking(request("turn-duplicate"), || {
            Ok(final_result("turn-duplicate"))
        })
        .expect_err("duplicate active turn should fail");
    assert!(error.to_string().contains("already active"));

    release_sender.send(()).expect("release should send");
    handle.wait().expect("first turn should finish");
}

#[test]
fn cancellation_removes_active_handle_and_ignores_late_completion() {
    let runtime = TurnExecutionRuntime::new();
    let (started_sender, started_receiver) = mpsc::channel();
    let (release_sender, release_receiver) = mpsc::channel();
    let handle = runtime
        .start_blocking(request("turn-cancel"), move || {
            started_sender.send(()).expect("start should send");
            release_receiver.recv().expect("release should arrive");
            Ok(final_result("turn-cancel"))
        })
        .expect("turn should start");
    started_receiver
        .recv()
        .expect("turn should enter operation");

    let outcome = runtime.cancel("turn-cancel", AgentCancelReason::UserRequested);
    let result = handle.wait().expect("cancel should produce a result");

    assert_eq!(outcome.state, "cancel_requested");
    assert!(outcome.active_task_removed);
    assert!(outcome.cleanup_pending);
    assert_eq!(runtime.active_count(), 0);
    assert_eq!(runtime.draining_count(), 1);
    assert_eq!(result["stopReason"], "cancelled");

    release_sender.send(()).expect("release should send");
    wait_until(Duration::from_secs(1), || runtime.draining_count() == 0);
    let status = runtime.status("turn-cancel").expect("status should remain");
    assert_eq!(status.terminal_outcome.as_deref(), Some("cancelled"));
    assert_eq!(status.late_results_ignored, 1);
}

#[test]
fn waiting_turn_releases_task_and_can_resume_with_same_identity() {
    let runtime = TurnExecutionRuntime::new();
    let first = runtime
        .start_blocking(request("turn-wait"), || {
            Ok(serde_json::json!({
                "runtime": "rust",
                "turnId": "turn-wait",
                "sessionId": "session:turn-wait",
                "stopReason": "awaiting_form",
                "checkpoint": { "resumeToken": "form:turn-wait" }
            }))
        })
        .expect("waiting turn should start");
    first.wait().expect("waiting result should complete task");

    let waiting = runtime
        .status("turn-wait")
        .expect("waiting status should remain");
    assert!(!waiting.active);
    assert_eq!(waiting.phase, "awaiting_form");
    assert_eq!(waiting.terminal_outcome, None);
    assert_eq!(waiting.checkpoint_ref.as_deref(), Some("form:turn-wait"));

    let second = runtime
        .start_blocking(request("turn-wait"), || Ok(final_result("turn-wait")))
        .expect("waiting turn should resume");
    second.wait().expect("resumed turn should finish");
    let completed = runtime
        .status("turn-wait")
        .expect("completed status should remain");
    assert_eq!(completed.generation, 2);
    assert_eq!(completed.terminal_outcome.as_deref(), Some("completed"));
}

#[test]
fn cooperative_pause_and_resume_continue_the_same_active_turn() {
    tauri::async_runtime::block_on(async {
        let runtime = TurnExecutionRuntime::new();
        let operation_runtime = runtime.clone();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let (paused_sender, paused_receiver) = tokio::sync::oneshot::channel();
        let handle = runtime
            .start_async(request("turn-pause"), async move {
                started_sender.send(()).expect("async start should send");
                loop {
                    if let Some(command_id) = operation_runtime.begin_pause("turn-pause") {
                        paused_sender
                            .send(command_id)
                            .expect("pause boundary should send");
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                let resume_command_id = operation_runtime
                    .wait_for_resume("turn-pause")
                    .await
                    .expect("paused turn should resume");
                Ok(serde_json::json!({
                    "runtime": "rust",
                    "turnId": "turn-pause",
                    "sessionId": "session:turn-pause",
                    "stopReason": "final_response",
                    "finalContent": resume_command_id,
                }))
            })
            .expect("pausable turn should start");
        started_receiver
            .await
            .expect("async turn should enter operation");

        let pause = runtime
            .request_pause("turn-pause", "command-pause")
            .expect("pause request should be accepted");
        assert_eq!(pause.state, "pause_requested");
        assert_eq!(
            paused_receiver
                .await
                .expect("turn should reach pause boundary"),
            "command-pause"
        );
        assert_eq!(
            runtime
                .status("turn-pause")
                .expect("status should exist")
                .phase,
            "paused"
        );

        let resume = runtime
            .request_resume("turn-pause", "command-resume")
            .expect("resume request should be accepted");
        assert_eq!(resume.state, "resume_requested");
        let result = handle.wait_async().await.expect("turn should finish");

        assert_eq!(result["turnId"], "turn-pause");
        assert_eq!(result["finalContent"], "command-resume");
        assert_eq!(runtime.active_count(), 0);
        assert_eq!(
            runtime
                .status("turn-pause")
                .expect("completed status should remain")
                .terminal_outcome
                .as_deref(),
            Some("completed")
        );
    });
}

#[test]
fn shutdown_is_bounded_reports_cleanup_and_can_resume_accepting() {
    let runtime = TurnExecutionRuntime::new();
    let (release_sender, release_receiver) = mpsc::channel();
    let handle = runtime
        .start_blocking(request("turn-shutdown"), move || {
            release_receiver.recv().expect("release should arrive");
            Ok(final_result("turn-shutdown"))
        })
        .expect("turn should start");

    let report = runtime.shutdown(Duration::from_millis(25));
    assert_eq!(report.cancelled_turns, vec!["turn-shutdown"]);
    assert_eq!(report.cleanup_pending_turns, vec!["turn-shutdown"]);
    assert!(report.timed_out);
    assert_eq!(runtime.active_count(), 0);
    assert!(runtime
        .start_blocking(request("turn-rejected"), || Ok(final_result(
            "turn-rejected"
        )))
        .is_err());
    assert_eq!(handle.wait().unwrap()["stopReason"], "cancelled");

    release_sender.send(()).expect("release should send");
    wait_until(Duration::from_secs(1), || runtime.draining_count() == 0);
    runtime.resume_accepting();
    runtime
        .start_blocking(request("turn-restarted"), || {
            Ok(final_result("turn-restarted"))
        })
        .expect("runtime should accept after resume")
        .wait()
        .expect("restarted turn should finish");
}

#[test]
fn shutdown_does_not_publish_terminal_result_before_cooperative_cleanup() {
    tauri::async_runtime::block_on(async {
        let runtime = TurnExecutionRuntime::new();
        let cleanup_completed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let operation_cleanup_completed = cleanup_completed.clone();
        let token_slot = Arc::new(Mutex::new(None::<CancellationToken>));
        let operation_token_slot = token_slot.clone();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let handle = runtime
            .start_cooperative_async(
                request("turn-shutdown-cleanup-order"),
                Duration::from_secs(1),
                async move {
                    let cancellation = loop {
                        if let Some(cancellation) = operation_token_slot
                            .lock()
                            .expect("operation token slot should not be poisoned")
                            .clone()
                        {
                            break cancellation;
                        }
                        tokio::task::yield_now().await;
                    };
                    started_sender.send(()).expect("async start should send");
                    cancellation.cancelled().await;
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    operation_cleanup_completed.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(cancelled_task_result(
                        &request("turn-shutdown-cleanup-order"),
                        AgentCancelReason::Shutdown.as_str(),
                    ))
                },
            )
            .expect("cooperative turn should start");
        *token_slot
            .lock()
            .expect("test token slot should not be poisoned") =
            runtime.cancellation_token("turn-shutdown-cleanup-order");
        started_receiver
            .await
            .expect("cooperative operation should start");

        let shutdown_runtime = runtime.clone();
        let shutdown = thread::spawn(move || shutdown_runtime.shutdown(Duration::from_secs(1)));
        while !runtime
            .status("turn-shutdown-cleanup-order")
            .is_some_and(|status| status.cancellation_requested)
        {
            tokio::task::yield_now().await;
        }

        let result = handle
            .wait_async()
            .await
            .expect("shutdown should publish a cancellation result");
        let cleanup_was_complete_when_result_published =
            cleanup_completed.load(std::sync::atomic::Ordering::SeqCst);
        let report = shutdown.join().expect("shutdown thread should finish");

        assert_eq!(result["stopReason"], "cancelled");
        assert!(
            cleanup_was_complete_when_result_published,
            "shutdown published a terminal result before owned cleanup completed"
        );
        assert!(!report.timed_out);
        assert!(report.cleanup_pending_turns.is_empty());
    });
}

#[test]
fn async_cancellation_drops_operation_without_a_late_completion() {
    tauri::async_runtime::block_on(async {
        struct DropSignal(Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

        let runtime = TurnExecutionRuntime::new();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let operation_dropped = dropped.clone();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let handle = runtime
            .start_async(request("turn-async-cancel"), async move {
                let _drop_signal = DropSignal(operation_dropped);
                started_sender.send(()).expect("async start should send");
                std::future::pending::<Result<Value, String>>().await
            })
            .expect("async turn should start");
        started_receiver
            .await
            .expect("async turn should enter future");

        let outcome = runtime.cancel("turn-async-cancel", AgentCancelReason::UserRequested);
        let result = handle
            .wait_async()
            .await
            .expect("async cancellation should complete");

        assert_eq!(outcome.state, "cancel_requested");
        assert_eq!(result["stopReason"], "cancelled");
        for _ in 0..100 {
            if runtime.draining_count() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let status = runtime
            .status("turn-async-cancel")
            .expect("async cancelled status should remain");
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(runtime.draining_count(), 0);
        assert_eq!(status.late_results_ignored, 0);
    });
}

#[test]
fn cooperative_async_cancellation_reports_cleanup_timeout_and_releases_owner() {
    tauri::async_runtime::block_on(async {
        let metrics_before =
            crate::runtime::observability::global_agent_runtime_metrics().snapshot();
        struct DropSignal(Arc<std::sync::atomic::AtomicBool>);

        impl Drop for DropSignal {
            fn drop(&mut self) {
                self.0.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }

        let runtime = TurnExecutionRuntime::new();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let operation_dropped = dropped.clone();
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let handle = runtime
            .start_cooperative_async(
                request("turn-cooperative-cleanup-timeout"),
                Duration::from_millis(20),
                async move {
                    let _drop_signal = DropSignal(operation_dropped);
                    started_sender.send(()).expect("async start should send");
                    std::future::pending::<Result<Value, String>>().await
                },
            )
            .expect("cooperative async turn should start");
        started_receiver
            .await
            .expect("cooperative async turn should enter future");

        let outcome = runtime.request_cancel(
            "turn-cooperative-cleanup-timeout",
            AgentCancelReason::UserRequested,
        );
        let result = handle
            .wait_async()
            .await
            .expect("cleanup timeout should be a structured result");

        assert_eq!(outcome.state, "cancel_requested");
        assert!(!outcome.active_task_removed);
        assert_eq!(result["stopReason"], "cancellation_cleanup_timeout");
        assert!(result["events"]
            .as_array()
            .expect("cleanup timeout events should be an array")
            .iter()
            .any(|event| event["eventName"] == "agent.cleanup_timeout"));
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(runtime.active_count(), 0);
        assert_eq!(runtime.draining_count(), 0);
        let metrics_after =
            crate::runtime::observability::global_agent_runtime_metrics().snapshot();
        assert!(
            metrics_after["counters"]["cancellation.cleanup.timed_out"]
                .as_u64()
                .unwrap_or_default()
                >= metrics_before["counters"]["cancellation.cleanup.timed_out"]
                    .as_u64()
                    .unwrap_or_default()
                    .saturating_add(1)
        );
        assert!(
            metrics_after["durations"]["cancellation.cleanup.durationMs"]["count"]
                .as_u64()
                .unwrap_or_default()
                >= metrics_before["durations"]["cancellation.cleanup.durationMs"]["count"]
                    .as_u64()
                    .unwrap_or_default()
                    .saturating_add(1)
        );
    });
}
