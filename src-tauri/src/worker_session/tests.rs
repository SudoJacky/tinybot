#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_loop_runtime_protocol::{
        AgentRuntimeEventEnvelope, AgentRuntimeEventSource, AgentRuntimeEventVisibility,
        AgentRuntimePhase, AgentTurnItemKind, AGENT_RUNTIME_EVENT_SCHEMA_VERSION,
    };
    use crate::worker_capability::{CapabilityPolicy, WorkerCapability};
    use crate::worker_protocol::{WorkerProtocolErrorCode, WorkerProtocolErrorSource};
    use serde_json::json;
    use std::path::PathBuf;

    #[test]
    fn default_policy_denies_session_metadata_read() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .get_metadata("session-1")
            .expect_err("session metadata should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.source, WorkerProtocolErrorSource::RustCore);
        assert_eq!(error.details["capability"], "session.metadata.read");
    }

    #[test]
    fn get_metadata_returns_matching_session_with_capability() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let metadata = rpc
            .get_metadata("session-1")
            .expect("session metadata should read");

        assert_eq!(metadata.session_id, "session-1");
        assert_eq!(metadata.title, "Native Core Migration");
        assert_eq!(metadata.workspace_dir, "D:/code/tinybot/tinybot");
        assert_eq!(metadata.extra["mode"], "desktop");
    }

    #[test]
    fn get_metadata_rejects_unknown_session_id() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let error = rpc
            .get_metadata("missing-session")
            .expect_err("unknown session should fail");

        assert_eq!(error.code, WorkerProtocolErrorCode::InvalidProtocol);
        assert_eq!(error.details["session_id"], "missing-session");
    }

    #[test]
    fn get_metadata_rejects_invalid_session_id() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        assert!(rpc.get_metadata("").is_err());
        assert!(rpc.get_metadata("../session").is_err());
        assert!(rpc.get_metadata("session\0id").is_err());
    }

    #[test]
    fn list_metadata_returns_sorted_sessions() {
        let mut later = session_fixture();
        later.session_id = "session-2".to_string();
        later.updated_at = "2026-06-09T10:30:00Z".to_string();
        let mut earlier = session_fixture();
        earlier.session_id = "session-1".to_string();
        earlier.updated_at = "2026-06-09T09:30:00Z".to_string();
        let rpc = WorkerSessionRpc::new(vec![earlier, later], read_policy());

        let sessions = rpc.list_metadata().expect("sessions should list");
        let ids: Vec<String> = sessions
            .into_iter()
            .map(|session| session.session_id)
            .collect();

        assert_eq!(ids, vec!["session-2", "session-1"]);
    }

    #[test]
    fn persistent_store_restores_sessions_after_worker_restarts() {
        let root = temp_workspace_root("session-persistence");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let mut rpc = WorkerSessionRpc::new_persistent(root.clone(), vec![], write_policy())
            .expect("persistent session rpc should initialize");

        rpc.append_messages(
            "websocket:chat-1",
            vec![json!({ "role": "user", "content": "remember me" })],
        )
        .expect("message should append");

        let store_path = root.join("sessions").join("sessions.sqlite");
        assert!(
            store_path.exists(),
            "persistent sessions should write under workspace sessions"
        );

        let restarted = WorkerSessionRpc::new_persistent(root, vec![], read_policy())
            .expect("store should load");
        let sessions = restarted
            .list_metadata()
            .expect("persisted session metadata should list");
        assert_eq!(
            sessions
                .iter()
                .map(|session| session.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["websocket:chat-1"]
        );

        let history = restarted
            .get_history("websocket:chat-1", 10)
            .expect("persisted history should load");
        assert_eq!(
            history.messages,
            vec![json!({ "role": "user", "content": "remember me" })]
        );
    }

    #[test]
    fn persistent_store_ignores_existing_json_session_store_fixture() {
        let root = temp_workspace_root("session-existing-store");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let store_path = root.join("sessions").join("store.json");
        std::fs::create_dir_all(store_path.parent().unwrap()).unwrap();
        std::fs::write(
            &store_path,
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "sessions": [
                    {
                        "session_id": "desktop:existing-session",
                        "title": "Existing desktop session",
                        "workspace_dir": "D:/Code/tinybot/tinybot",
                        "created_at": "2026-06-01T09:00:00Z",
                        "updated_at": "2026-06-01T09:05:00Z",
                        "extra": {
                            "messages": [
                                { "role": "user", "content": "load old session" },
                                { "role": "assistant", "content": "old session loaded" }
                            ],
                            "user_profile": { "name": "fixture-user" },
                            "last_consolidated": 0
                        }
                    }
                ]
            }))
            .unwrap(),
        )
        .unwrap();

        let rpc = WorkerSessionRpc::new_persistent(root, vec![], read_policy())
            .expect("existing session store should initialize");

        let sessions = rpc
            .list_metadata()
            .expect("existing session metadata should list");
        assert_eq!(sessions.len(), 0);

        let history = rpc
            .get_history("desktop:existing-session", 10)
            .expect("existing session history should load");
        assert_eq!(history.messages.len(), 0);
        assert_eq!(history.user_profile, json!({}));
    }

    #[test]
    fn agent_run_record_serializes_run_state() {
        let record = AgentRunRecord {
            session_id: "session-1".to_string(),
            run_id: "run-1".to_string(),
            thread_id: Some("thread-1".to_string()),
            turn_id: Some("turn-1".to_string()),
            parent_thread_id: None,
            child_thread_ids: vec!["thread-child-1".to_string()],
            status: AgentRunStatus::Waiting,
            phase: "awaiting_tool".to_string(),
            started_at: "unix-ms:1".to_string(),
            updated_at: "unix-ms:2".to_string(),
            completed_at: None,
            stop_reason: None,
            model: "fixture-model".to_string(),
            provider: Some("fixture".to_string()),
            max_iterations: 4,
            current_iteration: 1,
            conversation_message_ids: vec!["message-1".to_string()],
            trace_messages: vec![json!({ "role": "tool", "content": "README" })],
            trace_events: vec![json!({ "eventName": "agent.tool.result" })],
            completed_tool_results: vec![json!({ "toolCallId": "call-1" })],
            pending_tool_calls: vec![json!({ "toolCallId": "call-2" })],
            checkpoint: Some(json!({
                "schemaVersion": 1,
                "sessionId": "session-1",
                "runId": "run-1",
                "phase": "awaiting_tool"
            })),
            artifacts: vec![json!({ "type": "file", "path": "report.md" })],
            usage: vec![json!({ "totalTokens": 12 })],
            token_usage_info: None,
            instruction_provenance: Some(json!({ "contentHash": "abc" })),
            instruction_diagnostics: vec![json!({ "level": "warning" })],
            trace_context: Some(crate::agent_loop_runtime_protocol::AgentTraceContext {
                request_id: "request-1".to_string(),
                trace_id: "trace-1".to_string(),
                run_id: "run-1".to_string(),
                turn_id: "turn-1".to_string(),
                thread_id: Some("thread-1".to_string()),
                parent_run_id: None,
            }),
            error: Some(json!({ "message": "waiting" })),
        };

        let value = serde_json::to_value(&record).expect("run record should serialize");
        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["runId"], "run-1");
        assert_eq!(value["threadId"], "thread-1");
        assert_eq!(value["turnId"], "turn-1");
        assert_eq!(value["childThreadIds"][0], "thread-child-1");
        assert_eq!(value["status"], "waiting");
        assert_eq!(value["currentIteration"], 1);
        assert_eq!(value["completedToolResults"][0]["toolCallId"], "call-1");
        assert_eq!(value["instructionProvenance"]["contentHash"], "abc");
        assert_eq!(value["traceContext"]["traceId"], "trace-1");

        let restored: AgentRunRecord =
            serde_json::from_value(value).expect("run record should deserialize");
        assert_eq!(restored, record);
    }

    #[test]
    fn agent_run_store_isolates_runs_in_same_session() {
        let mut rpc = WorkerSessionRpc::new(vec![], read_write_policy());
        let mut first = agent_run_fixture("session-1", "run-1", AgentRunStatus::Running);
        first.updated_at = "unix-ms:1".to_string();
        let mut second = agent_run_fixture("session-1", "run-2", AgentRunStatus::Waiting);
        second.updated_at = "unix-ms:2".to_string();

        rpc.upsert_agent_run(first)
            .expect("first run should upsert");
        rpc.upsert_agent_run(second)
            .expect("second run should upsert");
        rpc.append_agent_run_trace_event(
            "session-1",
            "run-1",
            json!({ "eventName": "agent.tool.result", "payload": { "toolCallId": "call-1" } }),
        )
        .expect("trace event should append");
        rpc.set_agent_run_checkpoint(
            "session-1",
            "run-2",
            json!({ "sessionId": "session-1", "runId": "run-2", "phase": "awaiting_approval" }),
        )
        .expect("checkpoint should set");

        let first = rpc
            .get_agent_run("session-1", "run-1")
            .expect("first run should read");
        let second = rpc
            .get_agent_run("session-1", "run-2")
            .expect("second run should read");

        assert_eq!(first.trace_events.len(), 1);
        assert_eq!(first.checkpoint, None);
        assert!(second.trace_events.is_empty());
        assert_eq!(
            second.checkpoint.unwrap()["phase"],
            json!("awaiting_approval")
        );
    }

    #[test]
    fn agent_run_list_orders_by_updated_at_and_latest_resumable_checkpoint() {
        let mut rpc = WorkerSessionRpc::new(vec![], read_write_policy());
        let mut older = agent_run_fixture("session-1", "run-old", AgentRunStatus::Waiting);
        older.updated_at = "unix-ms:1".to_string();
        older.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-old" }));
        let mut newer = agent_run_fixture("session-1", "run-new", AgentRunStatus::Waiting);
        newer.updated_at = "unix-ms:3".to_string();
        newer.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-new" }));
        let mut completed = agent_run_fixture("session-1", "run-done", AgentRunStatus::Completed);
        completed.updated_at = "unix-ms:4".to_string();
        completed.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-done" }));

        rpc.upsert_agent_run(older).expect("older run should upsert");
        rpc.upsert_agent_run(newer).expect("newer run should upsert");
        rpc.upsert_agent_run(completed)
            .expect("completed run should upsert");

        let runs = rpc
            .list_agent_runs("session-1")
            .expect("runs should list");
        assert_eq!(
            runs.iter()
                .map(|run| run.run_id.as_str())
                .collect::<Vec<_>>(),
            vec!["run-done", "run-new", "run-old"]
        );

        let checkpoint = rpc
            .latest_resumable_agent_run_checkpoint("session-1")
            .expect("latest resumable lookup should succeed")
            .expect("resumable checkpoint should exist");
        assert_eq!(checkpoint.run_id, "run-new");
        assert_eq!(checkpoint.checkpoint["runId"], "run-new");
    }

    #[test]
    fn agent_run_mark_methods_update_terminal_state() {
        let mut rpc = WorkerSessionRpc::new(vec![], read_write_policy());
        rpc.upsert_agent_run(agent_run_fixture(
            "session-1",
            "run-1",
            AgentRunStatus::Running,
        ))
        .expect("run should upsert");

        let completed = rpc
            .mark_agent_run_completed(
                "session-1",
                "run-1",
                "final_response",
                Some("done".to_string()),
            )
            .expect("run should mark completed");
        assert_eq!(completed.status, AgentRunStatus::Completed);
        assert_eq!(completed.stop_reason.as_deref(), Some("final_response"));
        assert_eq!(completed.phase, "completed");
        assert!(completed.completed_at.is_some());

        rpc.upsert_agent_run(agent_run_fixture(
            "session-1",
            "run-2",
            AgentRunStatus::Running,
        ))
        .expect("second run should upsert");
        let failed = rpc
            .mark_agent_run_failed(
                "session-1",
                "run-2",
                "provider_error",
                json!({ "message": "provider failed" }),
            )
            .expect("run should mark failed");
        assert_eq!(failed.status, AgentRunStatus::Failed);
        assert_eq!(failed.error.as_ref().unwrap()["message"], "provider failed");

        rpc.upsert_agent_run(agent_run_fixture(
            "session-1",
            "run-3",
            AgentRunStatus::Running,
        ))
        .expect("third run should upsert");
        let cancelled = rpc
            .mark_agent_run_cancelled("session-1", "run-3")
            .expect("run should mark cancelled");
        assert_eq!(cancelled.status, AgentRunStatus::Cancelled);
        assert_eq!(cancelled.stop_reason.as_deref(), Some("cancelled"));
    }

    #[test]
    fn agent_run_summary_and_trace_page_omit_full_record_payloads() {
        let mut record = agent_run_fixture("session-1", "run-1", AgentRunStatus::Completed);
        record.trace_events = vec![json!({ "eventName": "agent.tool.result" })];
        record.completed_tool_results = vec![json!({ "toolCallId": "call-1", "toolName": "workspace.read_file" })];
        record.artifacts = vec![json!({ "type": "file" })];
        record.stop_reason = Some("final_response".to_string());
        record.completed_at = Some("unix-ms:2".to_string());

        let summary = AgentRunSummary::from_record(&record);
        assert_eq!(summary.run_id, "run-1");
        assert_eq!(summary.tool_call_count, 1);
        assert_eq!(summary.tools_used, vec!["workspace.read_file"]);
        assert_eq!(summary.artifact_count, 1);
        assert!(!serde_json::to_value(&summary)
            .expect("summary should serialize")
            .get("traceEvents")
            .is_some());

        let page = AgentRunTracePage::new("session-1", "run-1", vec![json!({ "eventName": "agent.done" })]);
        assert_eq!(page.session_id, "session-1");
        assert_eq!(page.run_id, "run-1");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.next_cursor, None);
    }

    #[test]
    fn runtime_state_restores_legacy_stored_trace_events() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        let mut record = agent_run_fixture("session-1", "run-legacy", AgentRunStatus::Completed);
        record.phase = "completed".to_string();
        record.completed_at = Some("unix-ms:2".to_string());
        record.stop_reason = Some("final_response".to_string());
        record.trace_events = vec![
            json!({
                "eventName": "agent.tool.result",
                "payload": {
                    "toolCallId": "call-legacy",
                    "toolName": "workspace.read_file",
                    "content": "README excerpt"
                }
            }),
            json!({
                "eventName": "agent.done",
                "payload": {
                    "finalContent": "Legacy final answer"
                }
            }),
        ];
        rpc.upsert_agent_run(record)
            .expect("legacy run should upsert");

        let runtime_state = rpc
            .get_agent_run_runtime_state("session-1", "run-legacy")
            .expect("legacy runtime state should restore");

        assert_eq!(runtime_state.runtime_events.len(), 2);
        assert_eq!(
            runtime_state.runtime_events[0].schema_version,
            "tinybot.agent_event.v1"
        );
        assert_eq!(runtime_state.turn_items[0].kind, AgentTurnItemKind::ToolCall);
        assert_eq!(runtime_state.turn_items[0].item_id, "call-legacy");
        assert_eq!(
            runtime_state.turn_items[1].kind,
            AgentTurnItemKind::AssistantMessage
        );
        assert_eq!(
            runtime_state.turn_items[1].payload["content"],
            "Legacy final answer"
        );
    }

    #[test]
    fn append_agent_run_status_event_updates_snapshot_state() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        let mut record = agent_run_fixture("session-1", "run-1", AgentRunStatus::Running);
        record.phase = "planning".to_string();
        record.current_iteration = 0;
        rpc.upsert_agent_run(record)
            .expect("running run should upsert");

        let status_event = AgentRuntimeEventEnvelope {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: "run-1:agent-status:0000000000000001".to_string(),
            sequence: 1,
            session_id: "session-1".to_string(),
            thread_id: None,
            turn_id: "run-1".to_string(),
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.status".to_string(),
            phase: AgentRuntimePhase::ToolRunning,
            timestamp: "unix-ms:2".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            trace_context: None,
            payload: json!({
                "runId": "run-1",
                "sessionId": "session-1",
                "phase": "tool_running",
                "label": "Running tool",
                "detail": "workspace.read_file",
                "iteration": 2,
                "isBlocking": false
            }),
        };

        let updated = rpc
            .append_agent_run_trace_event(
                "session-1",
                "run-1",
                serde_json::to_value(status_event).expect("status event should serialize"),
            )
            .expect("status event should append and update snapshot");

        assert_eq!(updated.status, AgentRunStatus::Running);
        assert_eq!(updated.phase, "tool_running");
        assert_eq!(updated.current_iteration, 2);
        assert_eq!(updated.trace_events.len(), 1);

        let restored = rpc
            .get_agent_run("session-1", "run-1")
            .expect("run should read");
        assert_eq!(restored.phase, "tool_running");
        assert_eq!(restored.current_iteration, 2);
    }

    #[test]
    fn terminal_agent_run_status_event_does_not_terminalize_snapshot() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        let mut record = agent_run_fixture("session-1", "run-terminal-status", AgentRunStatus::Running);
        record.phase = "finalizing".to_string();
        record.current_iteration = 2;
        rpc.upsert_agent_run(record)
            .expect("running run should upsert");

        let status_event = AgentRuntimeEventEnvelope {
            schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
            event_id: "run-terminal-status:agent-status:0000000000000001".to_string(),
            sequence: 1,
            session_id: "session-1".to_string(),
            thread_id: None,
            turn_id: "run-terminal-status".to_string(),
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.status".to_string(),
            phase: AgentRuntimePhase::Completed,
            timestamp: "unix-ms:3".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            trace_context: None,
            payload: json!({
                "runId": "run-terminal-status",
                "sessionId": "session-1",
                "phase": "completed",
                "label": "Completed",
                "detail": "agent.done",
                "iteration": 2,
                "isBlocking": false
            }),
        };

        let updated = rpc
            .append_agent_run_trace_event(
                "session-1",
                "run-terminal-status",
                serde_json::to_value(status_event).expect("status event should serialize"),
            )
            .expect("status event should append and update snapshot");

        assert_eq!(updated.phase, "completed");
        assert_eq!(updated.status, AgentRunStatus::Running);
        assert_eq!(updated.completed_at, None);
        assert_eq!(updated.stop_reason, None);
        assert_eq!(updated.error, None);
    }

    #[test]
    fn agent_run_upsert_preserves_original_started_at() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        let mut running = agent_run_fixture("session-1", "run-1", AgentRunStatus::Running);
        running.started_at = "unix-ms:1".to_string();
        running.updated_at = "unix-ms:1".to_string();
        let mut completed = agent_run_fixture("session-1", "run-1", AgentRunStatus::Completed);
        completed.started_at = "unix-ms:2".to_string();
        completed.updated_at = "unix-ms:3".to_string();
        completed.completed_at = Some("unix-ms:3".to_string());

        rpc.upsert_agent_run(running)
            .expect("running run should upsert");
        rpc.upsert_agent_run(completed)
            .expect("terminal run should upsert");
        let restored = rpc
            .get_agent_run("session-1", "run-1")
            .expect("run should read");

        assert_eq!(restored.started_at, "unix-ms:1");
        assert_eq!(restored.updated_at, "unix-ms:3");
        assert_eq!(restored.completed_at.as_deref(), Some("unix-ms:3"));
    }

    #[test]
    fn append_agent_run_trace_event_deduplicates_stable_event_ids() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        rpc.upsert_agent_run(agent_run_fixture(
            "session-1",
            "run-1",
            AgentRunStatus::Running,
        ))
        .expect("run should upsert");
        let event = json!({
            "schemaVersion": "tinybot.agent_event.v1",
            "eventId": "run-1:agent-done:0000000000000001",
            "eventName": "agent.done",
            "payload": { "stopReason": "final_response" }
        });

        rpc.append_agent_run_trace_event("session-1", "run-1", event.clone())
            .expect("first append should persist");
        rpc.append_agent_run_trace_event("session-1", "run-1", event)
            .expect("duplicate append should be accepted");
        let restored = rpc
            .get_agent_run("session-1", "run-1")
            .expect("run should read");

        assert_eq!(restored.trace_events.len(), 1);
        assert_eq!(
            restored.trace_events[0]["eventId"],
            "run-1:agent-done:0000000000000001"
        );
    }

    #[test]
    fn agent_run_trace_pages_are_bounded_by_cursor_and_limit() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());
        let mut record = agent_run_fixture("session-1", "run-1", AgentRunStatus::Running);
        record.trace_events = vec![
            json!({ "eventName": "agent.tool_call.delta" }),
            json!({ "eventName": "agent.tool.start" }),
            json!({ "eventName": "agent.tool.result" }),
        ];
        rpc.upsert_agent_run(record)
            .expect("run should upsert");

        let first_page = rpc
            .list_agent_run_trace_events("session-1", "run-1", None, Some(2))
            .expect("first trace page should read");
        let second_page = rpc
            .list_agent_run_trace_events(
                "session-1",
                "run-1",
                first_page.next_cursor.as_deref(),
                Some(2),
            )
            .expect("second trace page should read");

        assert_eq!(first_page.items.len(), 2);
        assert_eq!(first_page.items[0]["eventName"], "agent.tool_call.delta");
        assert_eq!(first_page.next_cursor.as_deref(), Some("2"));
        assert_eq!(second_page.items.len(), 1);
        assert_eq!(second_page.items[0]["eventName"], "agent.tool.result");
        assert_eq!(second_page.next_cursor, None);
    }

    #[test]
    fn persistent_store_restores_agent_runs_after_worker_restarts() {
        let root = temp_workspace_root("agent-run-persistence");
        let _cleanup = TempWorkspaceCleanup(root.clone());
        let mut rpc = WorkerSessionRpc::new_persistent(root.clone(), vec![], read_write_policy())
            .expect("persistent session rpc should initialize");
        let mut record = agent_run_fixture("websocket:chat-1", "run-1", AgentRunStatus::Completed);
        record.completed_tool_results = vec![json!({ "toolCallId": "call-1" })];

        rpc.upsert_agent_run(record)
            .expect("run record should persist");

        let restarted = WorkerSessionRpc::new_persistent(root, vec![], read_policy())
            .expect("store should load");
        let restored = restarted
            .get_agent_run("websocket:chat-1", "run-1")
            .expect("persisted run should load");

        assert_eq!(restored.status, AgentRunStatus::Completed);
        assert_eq!(restored.completed_tool_results[0]["toolCallId"], "call-1");
    }

    #[test]
    fn set_and_clear_checkpoint_update_session_extra_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let updated = rpc
            .set_checkpoint(
                "session-1",
                json!({ "phase": "awaiting_tools", "iteration": 0 }),
            )
            .expect("checkpoint should set");

        assert_eq!(
            updated.extra["runtime_checkpoint"],
            json!({ "phase": "awaiting_tools", "iteration": 0 })
        );

        let cleared = rpc
            .clear_checkpoint("session-1")
            .expect("checkpoint should clear");

        assert!(cleared.extra.get("runtime_checkpoint").is_none());
    }

    #[test]
    fn set_checkpoint_mirrors_run_id_checkpoint_into_agent_run_store() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], read_write_policy());

        let updated = rpc
            .set_checkpoint(
                "session-1",
                json!({
                    "schemaVersion": 1,
                    "sessionId": "session-1",
                    "runId": "run-checkpoint",
                    "phase": "awaiting_tool",
                    "iteration": 2,
                    "maxIterations": 4,
                    "completedToolResults": [{ "toolCallId": "call-1" }]
                }),
            )
            .expect("checkpoint should set");

        assert_eq!(updated.extra["runtime_checkpoint"]["runId"], "run-checkpoint");
        let run_checkpoint = rpc
            .get_agent_run_checkpoint("session-1", "run-checkpoint")
            .expect("run checkpoint should read")
            .expect("run checkpoint should exist");
        assert_eq!(run_checkpoint.checkpoint["phase"], "awaiting_tool");
        let run = rpc
            .get_agent_run("session-1", "run-checkpoint")
            .expect("mirrored run should exist");
        assert_eq!(run.status, AgentRunStatus::Waiting);
        assert_eq!(run.current_iteration, 2);
        assert_eq!(run.completed_tool_results[0]["toolCallId"], "call-1");
    }

    #[test]
    fn get_checkpoint_falls_back_to_latest_resumable_agent_run() {
        let mut session = session_fixture();
        let mut old_run = agent_run_fixture("session-1", "run-old", AgentRunStatus::Waiting);
        old_run.updated_at = "unix-ms:1".to_string();
        old_run.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-old" }));
        let mut new_run = agent_run_fixture("session-1", "run-new", AgentRunStatus::Waiting);
        new_run.updated_at = "unix-ms:2".to_string();
        new_run.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-new" }));
        session.extra = json!({
            "agent_runs": [
                serde_json::to_value(old_run).unwrap(),
                serde_json::to_value(new_run).unwrap()
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let checkpoint = rpc
            .get_checkpoint("session-1")
            .expect("checkpoint should read")
            .expect("latest resumable checkpoint should exist");

        assert_eq!(checkpoint["runId"], "run-new");
    }

    #[test]
    fn clear_checkpoint_clears_only_legacy_and_selected_run_checkpoint() {
        let mut session = session_fixture();
        let mut first = agent_run_fixture("session-1", "run-1", AgentRunStatus::Waiting);
        first.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-1" }));
        let mut second = agent_run_fixture("session-1", "run-2", AgentRunStatus::Waiting);
        second.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-2" }));
        session.extra = json!({
            "runtime_checkpoint": { "sessionId": "session-1", "runId": "run-1" },
            "agent_runs": [
                serde_json::to_value(first).unwrap(),
                serde_json::to_value(second).unwrap()
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], read_write_policy());

        rpc.clear_checkpoint("session-1")
            .expect("checkpoint should clear");

        assert!(rpc
            .get_agent_run_checkpoint("session-1", "run-1")
            .expect("first run should read")
            .is_none());
        assert!(rpc
            .get_agent_run_checkpoint("session-1", "run-2")
            .expect("second run should read")
            .is_some());
    }

    #[test]
    fn set_checkpoint_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .set_checkpoint(
                "desktop-session-1",
                json!({ "phase": "awaiting_tools", "iteration": 0 }),
            )
            .expect("checkpoint write should create session metadata");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert_eq!(updated.title, "Desktop Session desktop-session-1");
        assert_eq!(
            updated.extra["runtime_checkpoint"]["phase"],
            "awaiting_tools"
        );
    }

    #[test]
    fn clear_checkpoint_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .clear_checkpoint("desktop-session-1")
            .expect("checkpoint clear should be idempotent for new sessions");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert!(updated.extra.get("runtime_checkpoint").is_none());
    }

    #[test]
    fn clear_session_resets_messages_profile_and_checkpoint_with_write_capability() {
        let mut session = session_fixture();
        let mut run = agent_run_fixture("session-1", "run-1", AgentRunStatus::Waiting);
        run.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-1" }));
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "last_consolidated": 1,
            "user_profile": { "name": "Ada" },
            "runtime_checkpoint": { "phase": "awaiting_tools" },
            "last_context_metadata": { "historyMessageCount": 2 },
            "last_persisted_run_id": "run-1",
            "agent_runs": [
                serde_json::to_value(run).unwrap()
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .clear_session("session-1")
            .expect("session should clear");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 2);
        assert_eq!(result.messages_after, 0);
        assert!(result.checkpoint_cleared);
        assert_eq!(result.session.extra["messages"], json!([]));
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(result.session.extra["user_profile"], json!({}));
        assert!(result.session.extra.get("runtime_checkpoint").is_none());
        assert!(result.session.extra.get("last_context_metadata").is_none());
        assert!(result.session.extra.get("last_persisted_run_id").is_none());
        assert!(agent_run_records(&result.session)
            .into_iter()
            .all(|run| run.checkpoint.is_none()));
    }

    #[test]
    fn delete_session_removes_existing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let result = rpc
            .delete_session("session-1")
            .expect("session should delete");

        assert_eq!(result.session_id, "session-1");
        assert!(result.deleted);
        assert!(rpc.get_metadata("session-1").is_err());
    }

    #[test]
    fn delete_session_reports_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], write_policy());

        let result = rpc
            .delete_session("missing-session")
            .expect("missing session delete should be reported");

        assert_eq!(result.session_id, "missing-session");
        assert!(!result.deleted);
    }

    #[test]
    fn patch_metadata_merges_existing_metadata_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "metadata": {
                "pinned": false,
                "topic": "old"
            },
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .patch_metadata("session-1", json!({ "pinned": true }))
            .expect("metadata should patch");

        assert_eq!(updated.session_id, "session-1");
        assert_eq!(updated.extra["metadata"]["pinned"], json!(true));
        assert_eq!(updated.extra["metadata"]["topic"], json!("old"));
        assert_eq!(
            updated.extra["messages"],
            json!([{ "role": "user", "content": "hello" }])
        );
    }

    #[test]
    fn patch_metadata_updates_session_title_with_write_capability() {
        let session = session_fixture();
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .patch_metadata("session-1", json!({ "title": "你好" }))
            .expect("metadata title should patch");

        assert_eq!(updated.session_id, "session-1");
        assert_eq!(updated.title, "你好");
        assert_eq!(updated.extra["metadata"]["title"], json!("你好"));
    }

    #[test]
    fn get_checkpoint_returns_runtime_checkpoint_with_read_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "runtime_checkpoint": {
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let checkpoint = rpc
            .get_checkpoint("session-1")
            .expect("checkpoint should read");

        assert_eq!(
            checkpoint,
            Some(json!({
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }))
        );
    }

    #[test]
    fn get_checkpoint_returns_none_when_session_has_no_runtime_checkpoint() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], read_policy());

        let checkpoint = rpc
            .get_checkpoint("session-1")
            .expect("checkpoint read should allow missing checkpoint");

        assert_eq!(checkpoint, None);
    }

    #[test]
    fn get_checkpoint_returns_none_for_missing_session_with_read_capability() {
        let rpc = WorkerSessionRpc::new(vec![], read_policy());

        let checkpoint = rpc
            .get_checkpoint("desktop-session-1")
            .expect("missing session should behave like no checkpoint");

        assert_eq!(checkpoint, None);
    }

    #[test]
    fn get_history_returns_messages_user_profile_and_updated_at() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "first" },
                { "role": "assistant", "content": "second" },
                { "role": "user", "content": "third" }
            ],
            "user_profile": {
                "name": "Ada",
                "preferences": ["concise"]
            },
            "runtime_checkpoint": { "phase": "awaiting_tools" }
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 2)
            .expect("history should read");

        assert_eq!(history.session_id, "session-1");
        assert_eq!(history.updated_at, "2026-06-09T09:30:00Z");
        assert_eq!(
            history.messages,
            vec![json!({ "role": "user", "content": "third" })]
        );
        assert_eq!(
            history.user_profile,
            json!({ "name": "Ada", "preferences": ["concise"] })
        );
    }

    #[test]
    fn get_history_ignores_agent_run_trace_payloads() {
        let mut run = agent_run_fixture("session-1", "run-1", AgentRunStatus::Completed);
        run.trace_messages = vec![json!({ "role": "tool", "content": "large tool trace" })];
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "agent_runs": [serde_json::to_value(run).unwrap()]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 10)
            .expect("history should read");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "assistant", "content": "done" })
            ]
        );
    }

    #[test]
    fn get_history_projects_from_legal_user_and_tool_boundary() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "tool", "content": "orphan", "tool_call_id": "orphan-call", "name": "read_file" },
                { "role": "assistant", "content": "previous answer" },
                { "role": "user", "content": "run a task" },
                { "role": "progress", "content": "Task Progress", "_task_event": true },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done", "_task_event": true },
                { "role": "assistant", "content": "final done" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should read");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "run a task" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" }),
                json!({ "role": "assistant", "content": "final done" })
            ]
        );
    }

    #[test]
    fn get_history_preserves_camel_case_model_fields() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "inspect" },
                {
                    "role": "assistant",
                    "content": "",
                    "reasoningContent": "Need a tool.",
                    "thinkingBlocks": [{ "type": "thinking", "text": "trace" }],
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                },
                { "role": "tool", "content": "README", "toolCallId": "call-read", "name": "read_file" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should preserve model fields");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "inspect" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "reasoningContent": "Need a tool.",
                    "thinkingBlocks": [{ "type": "thinking", "text": "trace" }],
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "toolCallId": "call-read", "name": "read_file" })
            ]
        );
    }

    #[test]
    fn get_history_uses_camel_case_tool_calls_for_legal_boundary() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "inspect" },
                {
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ]
        });
        let rpc = WorkerSessionRpc::new(vec![session], read_policy());

        let history = rpc
            .get_history("session-1", 80)
            .expect("history should keep legal camelCase tool-call pairs");

        assert_eq!(
            history.messages,
            vec![
                json!({ "role": "user", "content": "inspect" }),
                json!({
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [
                        {
                            "id": "call-read",
                            "name": "read_file",
                            "argumentsJson": "{\"path\":\"README.md\"}"
                        }
                    ]
                }),
                json!({ "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" }),
                json!({ "role": "assistant", "content": "done" })
            ]
        );
    }

    #[test]
    fn get_history_returns_empty_projection_for_missing_session() {
        let rpc = WorkerSessionRpc::new(vec![], read_policy());

        let history = rpc
            .get_history("desktop-session-1", 80)
            .expect("missing session should project empty history");

        assert_eq!(history.session_id, "desktop-session-1");
        assert_eq!(history.messages, Vec::<serde_json::Value>::new());
        assert_eq!(history.user_profile, json!({}));
    }

    #[test]
    fn default_policy_denies_session_checkpoint_read() {
        let rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .get_checkpoint("session-1")
            .expect_err("checkpoint reads should require metadata read capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.metadata.read");
    }

    #[test]
    fn default_policy_denies_session_checkpoint_write() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .set_checkpoint("session-1", json!({ "phase": "awaiting_tools" }))
            .expect_err("checkpoint writes should require capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.write");
    }

    #[test]
    fn append_messages_extends_session_extra_messages_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "existing" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({ "role": "assistant", "content": "hello" }),
                    json!({ "role": "tool", "content": "result", "toolCallId": "call-1" }),
                ],
            )
            .expect("messages should append");

        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "existing" },
                { "role": "assistant", "content": "hello" },
                { "role": "tool", "content": "result", "toolCallId": "call-1" }
            ])
        );
    }

    #[test]
    fn append_messages_skips_duplicate_session_messages_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "next" }),
                    json!({ "role": "tool", "tool_call_id": "call-1", "name": "lookup", "content": "new" }),
                ],
            )
            .expect("messages should append without duplicating existing session history");

        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" },
                { "role": "assistant", "content": "next" }
            ])
        );
    }

    #[test]
    fn append_messages_dedupes_equivalent_tool_calls_across_field_shapes() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .append_messages(
                "session-1",
                vec![
                    json!({
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [
                            {
                                "id": "call-1",
                                "name": "lookup",
                                "argumentsJson": "{}"
                            }
                        ]
                    }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
            )
            .expect("equivalent tool call messages should dedupe across field shapes");

        assert_eq!(
            updated.extra["messages"],
            json!([
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "assistant", "content": "done" }
            ])
        );
    }

    #[test]
    fn append_messages_creates_missing_session_with_write_capability() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .append_messages(
                "desktop-session-1",
                vec![json!({ "role": "assistant", "content": "hello" })],
            )
            .expect("append should create session metadata");

        assert_eq!(updated.session_id, "desktop-session-1");
        assert_eq!(
            updated.extra["messages"],
            json!([{ "role": "assistant", "content": "hello" }])
        );
    }

    #[test]
    fn trim_session_keeps_recent_legal_suffix_with_write_capability() {
        let mut session = session_fixture();
        session.extra = json!({
            "last_consolidated": 2,
            "messages": [
                { "role": "user", "content": "old question" },
                { "role": "assistant", "content": "old answer" },
                { "role": "tool", "content": "orphan", "tool_call_id": "orphan-call", "name": "read_file" },
                { "role": "assistant", "content": "previous answer" },
                { "role": "user", "content": "run heartbeat task" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .trim_session("session-1", 3)
            .expect("session should trim to a legal suffix");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 8);
        assert_eq!(result.messages_after, 4);
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(
            result.session.extra["messages"],
            json!([
                { "role": "user", "content": "run heartbeat task" },
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-read",
                            "type": "function",
                            "function": { "name": "read_file", "arguments": "{}" }
                        }
                    ]
                },
                { "role": "tool", "content": "README", "tool_call_id": "call-read", "name": "read_file" },
                { "role": "assistant", "content": "done" }
            ])
        );
    }

    #[test]
    fn trim_session_zero_clears_session_like_legacy_retain_suffix() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "last_consolidated": 1,
            "user_profile": { "name": "Ada" },
            "runtime_checkpoint": { "phase": "awaiting_tools" },
            "last_context_metadata": { "historyMessageCount": 2 },
            "last_persisted_run_id": "run-1"
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let result = rpc
            .trim_session("session-1", 0)
            .expect("zero trim should clear session state");

        assert_eq!(result.messages_before, 2);
        assert_eq!(result.messages_after, 0);
        assert_eq!(result.session.extra["messages"], json!([]));
        assert_eq!(result.session.extra["last_consolidated"], json!(0));
        assert_eq!(result.session.extra["user_profile"], json!({}));
        assert!(result.session.extra.get("runtime_checkpoint").is_none());
        assert!(result.session.extra.get("last_context_metadata").is_none());
        assert!(result.session.extra.get("last_persisted_run_id").is_none());
    }

    #[test]
    fn upsert_task_progress_updates_existing_progress_message() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "existing" },
                {
                    "role": "progress",
                    "content": "old progress",
                    "_task_event": true,
                    "_task_plan_id": "plan-1",
                    "_task_progress": { "completed": 0 }
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(vec![session], write_policy());

        let updated = rpc
            .upsert_task_progress(
                "session-1",
                "plan-1",
                json!({ "completed": 1, "total": 2 }),
                "new progress".to_string(),
            )
            .expect("task progress should upsert");

        let messages = updated.extra["messages"]
            .as_array()
            .expect("messages should be an array");
        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0],
            json!({ "role": "user", "content": "existing" })
        );
        assert_eq!(messages[1]["role"], "progress");
        assert_eq!(messages[1]["content"], "new progress");
        assert_eq!(messages[1]["_progress"], true);
        assert_eq!(messages[1]["_task_event"], true);
        assert_eq!(
            messages[1]["_task_progress"],
            json!({ "completed": 1, "total": 2 })
        );
        assert_eq!(messages[1]["_task_plan_id"], "plan-1");
        assert_eq!(messages[1]["_tool_name"], "task");
        assert!(messages[1]["timestamp"].is_string());
    }

    #[test]
    fn upsert_task_progress_creates_progress_message() {
        let mut rpc = WorkerSessionRpc::new(vec![], write_policy());

        let updated = rpc
            .upsert_task_progress(
                "desktop:chat-1",
                "plan-1",
                json!({ "completed": 0, "total": 2 }),
                "progress".to_string(),
            )
            .expect("task progress should create session and message");

        assert_eq!(updated.session_id, "desktop:chat-1");
        let messages = updated.extra["messages"]
            .as_array()
            .expect("messages should be an array");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "progress");
        assert_eq!(messages[0]["content"], "progress");
        assert_eq!(messages[0]["_progress"], true);
        assert_eq!(messages[0]["_task_event"], true);
        assert_eq!(
            messages[0]["_task_progress"],
            json!({ "completed": 0, "total": 2 })
        );
        assert_eq!(messages[0]["_task_plan_id"], "plan-1");
        assert_eq!(messages[0]["_tool_name"], "task");
        assert!(messages[0]["timestamp"].is_string());
    }

    #[test]
    fn persist_turn_appends_messages_and_clears_checkpoint() {
        let mut session = session_fixture();
        let mut run = agent_run_fixture("session-1", "run-1", AgentRunStatus::Waiting);
        run.checkpoint = Some(json!({ "sessionId": "session-1", "runId": "run-1" }));
        session.extra = json!({
            "runtime_checkpoint": { "sessionId": "session-1", "runId": "run-1", "phase": "tools_completed" },
            "messages": [
                { "role": "user", "content": "existing" }
            ],
            "agent_runs": [
                serde_json::to_value(run).unwrap()
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
                true,
                Some(json!({
                    "historyMessageCount": 1,
                    "bridge": {
                        "missingSession": false
                    }
                })),
            )
            .expect("turn should persist");

        assert_eq!(result.session_id, "session-1");
        assert_eq!(result.messages_before, 1);
        assert_eq!(result.messages_after, 3);
        assert_eq!(result.saved_message_count, 2);
        assert_eq!(
            result.saved_messages,
            vec![
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "assistant", "content": "done" })
            ]
        );
        assert!(result.checkpoint_cleared);
        assert_eq!(result.duplicate_message_count, 0);
        assert_eq!(result.truncated_tool_result_count, 0);
        assert_eq!(
            result.omitted_side_effects,
            vec![
                "conversation_evidence",
                "memory_extraction",
                "consolidation",
                "user_profile_update"
            ]
        );
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "existing" },
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ])
        );
        assert!(updated.extra.get("runtime_checkpoint").is_none());
        assert!(rpc
            .get_agent_run_checkpoint("session-1", "run-1")
            .expect("run checkpoint should read")
            .is_none());
        assert!(rpc
            .get_checkpoint("session-1")
            .expect("fallback checkpoint should read")
            .is_none());
        assert_eq!(updated.extra["last_persisted_run_id"], "run-1");
        assert_eq!(
            updated.extra["last_context_metadata"],
            json!({
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            })
        );
    }

    #[test]
    fn persist_turn_skips_duplicate_session_messages() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-duplicate-1",
                vec![
                    json!({ "role": "user", "content": "hello" }),
                    json!({ "role": "assistant", "content": "next" }),
                    json!({ "role": "tool", "tool_call_id": "call-1", "name": "lookup", "content": "new" }),
                ],
                false,
                None,
            )
            .expect("turn should persist");

        assert_eq!(result.messages_before, 3);
        assert_eq!(result.messages_after, 4);
        assert_eq!(result.saved_message_count, 1);
        assert_eq!(
            result.saved_messages,
            vec![json!({ "role": "assistant", "content": "next" })]
        );
        assert_eq!(result.duplicate_message_count, 2);
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(
            updated.extra["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" },
                { "role": "tool", "toolCallId": "call-1", "name": "lookup", "content": "old" },
                { "role": "assistant", "content": "next" }
            ])
        );
    }

    #[test]
    fn persist_turn_dedupes_equivalent_tool_calls_across_field_shapes() {
        let mut session = session_fixture();
        session.extra = json!({
            "messages": [
                {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }
                    ]
                }
            ]
        });
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let result = rpc
            .persist_turn(
                "session-1",
                "run-1",
                vec![
                    json!({
                        "role": "assistant",
                        "content": "",
                        "toolCalls": [
                            {
                                "id": "call-1",
                                "name": "lookup",
                                "argumentsJson": "{}"
                            }
                        ]
                    }),
                    json!({ "role": "assistant", "content": "done" }),
                ],
                false,
                None,
            )
            .expect("equivalent tool call messages should dedupe across field shapes");

        assert_eq!(result.messages_before, 1);
        assert_eq!(result.messages_after, 2);
        assert_eq!(result.saved_message_count, 1);
        assert_eq!(
            result.saved_messages,
            vec![json!({ "role": "assistant", "content": "done" })]
        );
        assert_eq!(result.duplicate_message_count, 1);
        let updated = rpc.get_metadata("session-1").expect("session should exist");
        assert_eq!(updated.extra["messages"].as_array().map(Vec::len), Some(2));
    }

    #[test]
    fn default_policy_denies_session_append_messages() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .append_messages(
                "session-1",
                vec![json!({ "role": "assistant", "content": "hello" })],
            )
            .expect_err("append should require session write capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.write");
    }

    #[test]
    fn upload_temporary_file_adds_legacy_shaped_session_document() {
        let mut session = session_fixture();
        session.session_id = "websocket:chat-1".to_string();
        let mut rpc = WorkerSessionRpc::new(
            vec![session],
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        );

        let doc = rpc
            .upload_temporary_file("websocket:chat-1", "context.md", "md", "hello native", 12)
            .expect("temporary upload should be stored");

        assert_eq!(doc["name"], "context.md");
        assert_eq!(doc["file_type"], "md");
        assert_eq!(doc["content"], "hello native");
        assert_eq!(doc["chunk_count"], 1);
        assert_eq!(doc["size_bytes"], 12);
        assert_eq!(doc["temporary"], true);

        let updated = rpc
            .get_metadata("websocket:chat-1")
            .expect("session should exist");
        assert_eq!(updated.extra["temporary_files"][0], doc);
    }

    #[test]
    fn default_policy_denies_task_progress_upsert() {
        let mut rpc = WorkerSessionRpc::new(vec![session_fixture()], CapabilityPolicy::default());

        let error = rpc
            .upsert_task_progress(
                "session-1",
                "plan-1",
                json!({ "completed": 1 }),
                "progress".to_string(),
            )
            .expect_err("progress upsert should require session write capability");

        assert_eq!(error.code, WorkerProtocolErrorCode::CapabilityDenied);
        assert_eq!(error.details["capability"], "session.write");
    }

    fn read_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead])
    }

    fn write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([WorkerCapability::SessionWrite])
    }

    fn read_write_policy() -> CapabilityPolicy {
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ])
    }

    fn temp_workspace_root(name: &str) -> PathBuf {
        let nonce = now_session_timestamp().replace(':', "-");
        let root = std::env::temp_dir().join(format!(
            "tinybot-worker-session-{name}-{}-{nonce}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        root
    }

    struct TempWorkspaceCleanup(PathBuf);

    impl Drop for TempWorkspaceCleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn session_fixture() -> SessionMetadata {
        SessionMetadata {
            session_id: "session-1".to_string(),
            title: "Native Core Migration".to_string(),
            workspace_dir: "D:/code/tinybot/tinybot".to_string(),
            created_at: "2026-06-09T09:00:00Z".to_string(),
            updated_at: "2026-06-09T09:30:00Z".to_string(),
            extra: json!({ "mode": "desktop" }),
        }
    }

    fn agent_run_fixture(
        session_id: &str,
        run_id: &str,
        status: AgentRunStatus,
    ) -> AgentRunRecord {
        AgentRunRecord {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            thread_id: None,
            turn_id: None,
            parent_thread_id: None,
            child_thread_ids: Vec::new(),
            status,
            phase: "active_turn".to_string(),
            started_at: "unix-ms:0".to_string(),
            updated_at: "unix-ms:0".to_string(),
            completed_at: None,
            stop_reason: None,
            model: "fixture-model".to_string(),
            provider: Some("fixture".to_string()),
            max_iterations: 4,
            current_iteration: 0,
            conversation_message_ids: Vec::new(),
            trace_messages: Vec::new(),
            trace_events: Vec::new(),
            completed_tool_results: Vec::new(),
            pending_tool_calls: Vec::new(),
            checkpoint: None,
            artifacts: Vec::new(),
            usage: Vec::new(),
            token_usage_info: None,
            instruction_provenance: None,
            instruction_diagnostics: Vec::new(),
            trace_context: None,
            error: None,
        }
    }
}
