#[cfg(test)]
mod tests {
    use super::*;
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

        let store_path = root.join("sessions").join("store.json");
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
    fn persistent_store_loads_existing_session_store_fixture() {
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
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "desktop:existing-session");

        let history = rpc
            .get_history("desktop:existing-session", 10)
            .expect("existing session history should load");
        assert_eq!(history.messages.len(), 2);
        assert_eq!(history.user_profile["name"], "fixture-user");
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
        session.extra = json!({
            "runtime_checkpoint": { "phase": "tools_completed" },
            "messages": [
                { "role": "user", "content": "existing" }
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
}
