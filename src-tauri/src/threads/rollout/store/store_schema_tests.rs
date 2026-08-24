use super::*;

#[test]
fn historical_compacted_usage_recovers_context_metrics_from_token_count() {
    let thread_id = "thread-usage-recovery";
    let turn_id = "turn-usage";
    let lines = [
        serde_json::json!({
            "timestamp": "2026-08-24T09:33:10.393Z",
            "ordinal": 11,
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "payload": {
                    "turnId": turn_id,
                    "info": {
                        "modelContextWindow": 1000000,
                        "usage": {
                            "cachedInputTokens": 4096,
                            "inputTokens": 4130,
                            "outputTokens": 85,
                            "totalTokens": 4215
                        }
                    }
                }
            }
        }),
        serde_json::json!({
            "timestamp": "2026-08-24T09:33:10.411Z",
            "ordinal": 12,
            "type": "event_msg",
            "payload": {
                "type": "thread_item",
                "payload": {
                    "item": {
                        "createdAt": "2026-08-24T09:33:10.411Z",
                        "itemId": "semantic-usage",
                        "kind": {
                            "type": "event",
                            "payload": {
                                "eventName": "agent.usage",
                                "payload": {
                                    "agentItem": {
                                        "id": "turn-usage:usage:0",
                                        "inputTokens": 4130,
                                        "outputTokens": 85,
                                        "providerPayload": {
                                            "input_tokens": 4130,
                                            "input_tokens_details": { "cached_tokens": 4096 },
                                            "output_tokens": 85,
                                            "total_tokens": 4215
                                        },
                                        "totalTokens": 4215,
                                        "type": "usage"
                                    }
                                }
                            }
                        },
                        "parentItemId": null,
                        "sequence": 0,
                        "threadId": thread_id,
                        "turnId": turn_id
                    }
                }
            }
        }),
    ]
    .into_iter()
    .map(|value| serde_json::from_value::<ThreadLogLine>(value).unwrap())
    .collect::<Vec<_>>();

    let items = thread_items_from_effective_rollout(&lines, &[0, 1], thread_id).unwrap();
    let ThreadItemKind::Event(usage) = &items[0].kind else {
        panic!("usage should reconstruct as an event item");
    };
    let agent_item = &usage["payload"]["agentItem"];

    assert_eq!(agent_item["contextWindowTokens"], 1_000_000);
    assert_eq!(agent_item["contextWindowUsedTokens"], 4_215);
    assert_eq!(agent_item["contextWindowRemainingTokens"], 995_785);
    assert_eq!(agent_item["percent"], 0.4215);

    let events =
        crate::threads::domain::runtime_events_from_thread_items(&items, thread_id, turn_id);
    let projected = crate::agent::runtime_protocol::project_turn_items_from_trace_events(&events);
    let usage = serde_json::to_value(&projected[0].data).unwrap();
    assert_eq!(usage["contextWindowTokens"], 1_000_000);
    assert_eq!(usage["contextWindowUsedTokens"], 4_215);
    assert_eq!(
        usage["providerPayload"]["input_tokens_details"]["cached_tokens"],
        4_096
    );
}

#[test]
fn future_thread_log_schema_is_rejected_explicitly() {
    let error = thread_meta_from_lines(&[ThreadLogLine {
        timestamp: "2026-07-10T00:00:00Z".to_string(),
        ordinal: None,
        item: ThreadLogItem::SessionMeta(ThreadMeta {
            schema_version: THREAD_LOG_SCHEMA_VERSION + 1,
            thread_id: "thread-future-schema".to_string(),
            session_id: None,
            created_at: "2026-07-10T00:00:00Z".to_string(),
            cwd: String::new(),
            source: "test".to_string(),
            model_provider: None,
            api_mode: None,
            model: None,
            base_instructions: None,
            memory_snapshot: None,
            history_mode: None,
            forked_from_thread_id: None,
            parent_thread_id: None,
            originator: None,
        }),
    }])
    .unwrap_err();

    assert!(error
        .message
        .contains("unsupported thread log schema version"));
    assert_eq!(error.details["supportedSchemaVersion"], 1);
}

#[test]
fn new_thread_pins_responses_mode_in_session_meta() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-api-mode-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let thread = ThreadRecord {
        thread_id: "thread-responses-mode".to_string(),
        title: "Responses mode".to_string(),
        status: ThreadStatus::Empty,
        session_key: Some("session-responses-mode".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-08-01T00:00:00Z".to_string(),
        updated_at: "2026-08-01T00:00:00Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata {
            extra: serde_json::json!({ "apiMode": "responses" }),
            ..Default::default()
        },
    };

    rpc.create_from_thread_record(&thread).unwrap();
    let record = rpc
        .state
        .find_by_session_or_thread_id(&thread.thread_id)
        .unwrap()
        .unwrap();
    let lines = read_thread_lines(Path::new(&record.thread_path)).unwrap();
    let meta = thread_meta_from_lines(&lines).unwrap();

    assert_eq!(meta.api_mode, Some(SessionApiMode::Responses));
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn startup_consumers_read_each_rollout_once() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-startup-rollout-reuse-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    let writer = WorkerThreadLogRpc::new(root.clone(), policy.clone());
    for index in 0..20 {
        writer
            .create_from_thread_record(&ThreadRecord {
                thread_id: format!("thread-startup-reuse-{index}"),
                title: format!("Startup reuse {index}"),
                status: ThreadStatus::Empty,
                session_key: Some(format!("session-startup-reuse-{index}")),
                root_turn_id: None,
                active_turn_id: None,
                parent_thread_id: None,
                source: "test".to_string(),
                created_at: "2026-08-24T00:00:00Z".to_string(),
                updated_at: "2026-08-24T00:00:00Z".to_string(),
                archived_at: None,
                metadata: ThreadMetadata::default(),
            })
            .unwrap();
    }
    writer.flush_all().unwrap();
    drop(writer);

    let rpc = WorkerThreadLogRpc::new(root.clone(), policy);
    rpc.reset_rollout_read_count();
    rpc.thread_projection().unwrap();
    rpc.prepare_state_index_for_startup().unwrap();
    rpc.check_state_index().unwrap();
    rpc.thread_projection().unwrap();
    rpc.reconcile_orphaned_turns().unwrap();
    rpc.invalidate_state_index();
    rpc.thread_projection().unwrap();

    assert_eq!(rpc.rollout_read_count(), 20);
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollout_cache_refreshes_after_an_append_changes_the_log_head() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-rollout-cache-refresh-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionMetadataRead,
        WorkerCapability::SessionWrite,
    ]);
    let writer = WorkerThreadLogRpc::new(root.clone(), policy.clone());
    writer
        .create_from_thread_record(&ThreadRecord {
            thread_id: "thread-cache-refresh".to_string(),
            title: "Before append".to_string(),
            status: ThreadStatus::Empty,
            session_key: Some("session-cache-refresh".to_string()),
            root_turn_id: None,
            active_turn_id: None,
            parent_thread_id: None,
            source: "test".to_string(),
            created_at: "2026-08-24T00:00:00Z".to_string(),
            updated_at: "2026-08-24T00:00:00Z".to_string(),
            archived_at: None,
            metadata: ThreadMetadata::default(),
        })
        .unwrap();
    writer.flush_all().unwrap();
    drop(writer);

    let rpc = WorkerThreadLogRpc::new(root.clone(), policy);
    rpc.reset_rollout_read_count();
    let (mut threads, _) = rpc.thread_projection().unwrap();
    assert_eq!(rpc.rollout_read_count(), 1);

    let mut updated = threads.pop().unwrap();
    updated.title = "After append".to_string();
    updated.updated_at = "2026-08-24T00:00:01Z".to_string();
    rpc.create_from_thread_record(&updated).unwrap();
    rpc.flush_all().unwrap();

    let (threads, _) = rpc.thread_projection().unwrap();
    assert_eq!(rpc.rollout_read_count(), 2);
    assert_eq!(threads[0].title, "After append");
    drop(rpc);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn rollout_reconstruction_rejects_turnless_thread_items() {
    let lines = vec![ThreadLogLine {
        timestamp: "2026-07-23T00:00:00Z".to_string(),
        ordinal: Some(0),
        item: value_event(
            EventKind::UserMessage,
            serde_json::json!({ "message": "missing turn identity" }),
        ),
    }];

    let error = thread_items_from_effective_rollout(&lines, &[0], "thread-turnless")
        .expect_err("turnless Rollout records must not project as Thread items");

    assert_eq!(
        error.message,
        "canonical Rollout item is missing its turn id"
    );
    assert_eq!(error.details["itemType"], "user_message");
}

#[test]
fn rollout_reconstruction_skips_historical_approval_items_without_losing_other_history() {
    let thread_item = |ordinal, item_id: &str, kind: Value| ThreadLogLine {
        timestamp: format!("2026-07-23T00:00:0{ordinal}Z"),
        ordinal: Some(ordinal),
        item: value_event(
            EventKind::ThreadItem,
            serde_json::json!({
                "item": {
                    "itemId": item_id,
                    "threadId": "thread-history",
                    "turnId": "turn-1",
                    "sequence": ordinal + 1,
                    "createdAt": "2026-07-23T00:00:00Z",
                    "kind": kind
                }
            }),
        ),
    };
    let lines = vec![
        thread_item(
            0,
            "old-request",
            serde_json::json!({
                "type": "approval_requested",
                "payload": { "approvalId": "old-1" }
            }),
        ),
        thread_item(
            1,
            "message-1",
            serde_json::json!({
                "type": "user_message",
                "payload": { "content": "keep this message" }
            }),
        ),
        thread_item(
            2,
            "old-decision",
            serde_json::json!({
                "type": "approval_resolved",
                "payload": { "approvalId": "old-1" }
            }),
        ),
    ];

    let items = thread_items_from_effective_rollout(&lines, &[0, 1, 2], "thread-history")
        .expect("historical compatibility items should not prevent reconstruction");

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "message-1");
    assert!(matches!(items[0].kind, ThreadItemKind::UserMessage(_)));
}

#[test]
fn legacy_responses_history_uses_replay_order_across_mixed_source_sequences() {
    let turn_id = "turn-mixed-sequence";
    let thread_id = "thread-mixed-sequence";
    let lines = vec![
        ThreadLogLine {
            timestamp: "2026-08-14T07:20:01Z".to_string(),
            ordinal: Some(39),
            item: value_event(
                EventKind::ThreadItem,
                serde_json::json!({
                    "item": {
                        "itemId": "semantic-tool-call",
                        "threadId": thread_id,
                        "turnId": turn_id,
                        "sequence": 0,
                        "createdAt": "2026-08-14T07:20:01Z",
                        "kind": {
                            "type": "event",
                            "payload": {
                                "schemaVersion": "tinybot.agent_event.v1",
                                "eventId": "tool-call-event",
                                "sequence": 56,
                                "sessionId": thread_id,
                                "threadId": thread_id,
                                "turnId": turn_id,
                                "itemId": "call-1",
                                "eventName": "agent.tool_call.delta",
                                "phase": "tool_calling",
                                "timestamp": "1786692001743",
                                "source": "tool",
                                "visibility": "user",
                                "payload": {
                                    "toolCallId": "call-1",
                                    "toolName": "exec_command",
                                    "argumentsDelta": "{}"
                                }
                            }
                        }
                    }
                }),
            ),
        },
        ThreadLogLine {
            timestamp: "2026-08-14T07:20:02Z".to_string(),
            ordinal: Some(42),
            item: ThreadLogItem::ResponseItem(
                typed_response_item(
                    serde_json::json!({
                        "type": "function_call_output",
                        "call_id": "call-1",
                        "turnId": turn_id,
                        "threadItemSequence": 67,
                        "timestamp": "1786692002260",
                        "status": "ok",
                        "output": "done"
                    }),
                    "legacy mixed-sequence test output",
                )
                .unwrap(),
            ),
        },
        ThreadLogLine {
            timestamp: "2026-08-14T07:20:03Z".to_string(),
            ordinal: Some(55),
            item: ThreadLogItem::ResponseItem(
                typed_response_item(
                    serde_json::json!({
                        "type": "message",
                        "id": "final-1",
                        "role": "assistant",
                        "turnId": turn_id,
                        "content": [{ "type": "output_text", "text": "Done." }]
                    }),
                    "legacy mixed-sequence test final answer",
                )
                .unwrap(),
            ),
        },
    ];

    let thread_items = thread_items_from_effective_rollout(&lines, &[0, 1, 2], thread_id)
        .expect("legacy Rollout should reconstruct");
    let events =
        crate::threads::domain::runtime_events_from_thread_items(&thread_items, thread_id, turn_id);
    assert_eq!(
        events
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        vec![56, 67, 55]
    );

    let snapshot =
        crate::agent::runtime_protocol::project_timeline_snapshot(thread_id, turn_id, &events)
            .expect("replay order should keep historical tools before the final answer");
    assert_eq!(
        snapshot
            .items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["call-1", "final-1"]
    );
}

#[test]
fn responses_tool_outputs_reuse_turn_local_sequences_without_identity_collision() {
    let thread_id = "thread-reused-tool-sequence";
    let tool_output = |ordinal, turn_id: &str, call_id: &str| ThreadLogLine {
        timestamp: "2026-08-19T10:11:45Z".to_string(),
        ordinal: Some(ordinal),
        item: ThreadLogItem::ResponseItem(
            typed_response_item(
                serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "turnId": turn_id,
                    "threadItemSequence": 14,
                    "status": "ok",
                    "output": "done"
                }),
                "reused tool sequence test output",
            )
            .unwrap(),
        ),
    };
    let lines = vec![
        tool_output(87, "turn-1", "call-1"),
        tool_output(104, "turn-2", "call-2"),
    ];

    let items = thread_items_from_effective_rollout(&lines, &[0, 1], thread_id)
        .expect("turn-local tool sequences must not collide across turns");

    assert_eq!(items.len(), 2);
    assert_eq!(
        items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec![
            "rollout:thread-reused-tool-sequence:turn-1:14",
            "rollout:thread-reused-tool-sequence:turn-2:14",
        ]
    );
}

#[test]
fn repeated_identical_thread_record_does_not_append_metadata_snapshot() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-metadata-noop-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("test workspace should create");
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let mut thread = ThreadRecord {
        thread_id: "thread-metadata-noop".to_string(),
        title: "Metadata no-op".to_string(),
        status: ThreadStatus::Idle,
        session_key: Some("session-metadata-noop".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-07-20T00:00:00Z".to_string(),
        updated_at: "2026-07-20T00:00:00Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata {
            preview: Some("first preview".to_string()),
            last_activity_at: Some("2026-07-20T00:00:00Z".to_string()),
            extra: serde_json::json!({"clientThreadId": "client-thread-1"}),
            ..Default::default()
        },
    };

    rpc.create_from_thread_record(&thread)
        .expect("initial thread record should persist");
    let record = rpc
        .state
        .find_by_session_or_thread_id(&thread.thread_id)
        .expect("thread lookup should succeed")
        .expect("thread should be indexed");
    let path = PathBuf::from(record.thread_path);
    let initial_line_count = read_thread_lines(&path)
        .expect("initial Rollout should read")
        .len();
    thread_record_cache()
        .lock()
        .expect("thread record cache should lock")
        .remove(&path);
    drop(rpc);
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );

    rpc.create_from_thread_record(&thread)
        .expect("identical thread record should be accepted after cache reset");
    assert_eq!(
        read_thread_lines(&path)
            .expect("Rollout after no-op should read")
            .len(),
        initial_line_count,
        "an identical thread record must not append another metadata snapshot"
    );

    thread.updated_at = "2026-07-20T00:00:01Z".to_string();
    thread.metadata.last_activity_at = Some("2026-07-20T00:00:01Z".to_string());
    thread.metadata.extra = serde_json::json!({"clientThreadId": "client-thread-2"});
    rpc.create_from_thread_record(&thread)
        .expect("changed thread record should persist");
    assert_eq!(
        read_thread_lines(&path)
            .expect("Rollout after metadata change should read")
            .len(),
        initial_line_count + 1,
        "a changed thread record should append exactly one metadata snapshot"
    );

    drop(rpc);
    std::fs::remove_dir_all(root).expect("test workspace should clean up");
}

#[test]
fn persistence_check_and_repair_use_the_process_local_index() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-index-repair-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("test workspace should create");
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    rpc.create_from_thread_record(&ThreadRecord {
        thread_id: "thread-index-repair".to_string(),
        title: "Index repair".to_string(),
        status: ThreadStatus::Idle,
        session_key: Some("session-index-repair".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-07-28T00:00:00Z".to_string(),
        updated_at: "2026-07-28T00:00:00Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata::default(),
    })
    .expect("thread record should persist");
    rpc.state.reset().expect("in-memory index should reset");

    let before = rpc
        .check_state_index()
        .expect("index consistency should inspect canonical Rollouts");
    assert_eq!(before.status, ThreadLogIndexConsistencyStatus::MissingIndex);

    let repair = rpc
        .repair_state_index(ThreadLogIndexRepairMode::RebuildIndex)
        .expect("repair should rebuild the in-memory index");
    assert_eq!(repair.rebuilt_thread_count, 1);
    assert_eq!(repair.after.status, ThreadLogIndexConsistencyStatus::Clean);
    assert!(!root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());

    drop(rpc);
    std::fs::remove_dir_all(root).expect("test workspace should clean up");
}

#[test]
fn thread_item_timestamp_is_persisted_as_iso_8601() {
    let root = std::env::temp_dir().join(format!(
        "tinybot-thread-item-timestamp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos()
    ));
    std::fs::create_dir_all(&root).expect("test workspace should create");
    let rpc = WorkerThreadLogRpc::new(
        root.clone(),
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let thread = ThreadRecord {
        thread_id: "thread-item-timestamp".to_string(),
        title: "Timestamp".to_string(),
        status: ThreadStatus::Idle,
        session_key: Some("session-item-timestamp".to_string()),
        root_turn_id: None,
        active_turn_id: None,
        parent_thread_id: None,
        source: "test".to_string(),
        created_at: "2026-07-22T08:49:40.228Z".to_string(),
        updated_at: "2026-07-22T08:49:40.228Z".to_string(),
        archived_at: None,
        metadata: ThreadMetadata::default(),
    };
    rpc.create_from_thread_record(&thread)
        .expect("thread record should persist");
    let missing_turn_error = rpc
        .append_thread_items(
            &thread.thread_id,
            &[ThreadItem {
                item_id: "thread-item-without-turn".to_string(),
                thread_id: thread.thread_id.clone(),
                turn_id: String::new(),
                parent_item_id: None,
                sequence: 1,
                created_at: "2026-07-22T08:49:40.228Z".to_string(),
                kind: ThreadItemKind::UserMessage(serde_json::json!({
                    "content": "invalid",
                    "role": "user"
                })),
            }],
        )
        .expect_err("thread items without a turn must be rejected");
    assert_eq!(
        missing_turn_error.message,
        "thread item turnId must not be empty"
    );
    rpc.append_thread_items(
        &thread.thread_id,
        &[ThreadItem {
            item_id: "thread-runtime:thread-item-timestamp:turn-1:user".to_string(),
            thread_id: thread.thread_id.clone(),
            turn_id: "turn-1".to_string(),
            parent_item_id: None,
            sequence: 1,
            created_at: "1784710180728".to_string(),
            kind: ThreadItemKind::UserMessage(serde_json::json!({
                "content": "hello",
                "role": "user"
            })),
        }],
    )
    .expect("thread item should persist");

    let record = rpc
        .state
        .find_by_session_or_thread_id(&thread.thread_id)
        .expect("thread lookup should succeed")
        .expect("thread should be indexed");
    let lines = read_thread_lines(Path::new(&record.thread_path))
        .expect("Rollout should read after thread item append");
    assert_eq!(
        lines
            .last()
            .expect("thread item line should exist")
            .timestamp,
        "2026-07-22T08:49:40.728Z"
    );

    drop(rpc);
    std::fs::remove_dir_all(root).expect("test workspace should clean up");
}
