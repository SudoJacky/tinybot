use super::*;

#[test]
fn session_get_metadata_does_not_read_in_memory_legacy_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_metadata",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result, Some(Value::Null));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_list_metadata_includes_only_rollout_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-list-thread-create",
        "trace-session-list-thread",
        "thread.create",
        json!({
            "threadId": "thread-only-session",
            "title": "Thread Only Session",
            "sessionKey": "thread-session-1",
            "metadata": {
                "workingDirectory": "D:/code/tinybot/workspace",
                "lastActivityAt": "2026-07-05T03:00:00Z",
                "preview": "Thread-only preview"
            },
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let response = router.dispatch(&WorkerRequest::new(
        "req-session-list-thread",
        "trace-session-list-thread",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(response.error, None);
    let sessions = response.result.as_ref().unwrap().as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0]["session_id"], "thread-session-1");
    assert_eq!(sessions[0]["title"], "Thread Only Session");
    assert_eq!(sessions[0]["workspace_dir"], "D:/code/tinybot/workspace");
    assert_eq!(sessions[0]["updated_at"], "2026-07-05T03:00:00Z");
    assert_eq!(sessions[0]["extra"]["threadId"], "thread-only-session");
    assert_eq!(sessions[0]["extra"]["source"], "thread.metadata_projection");
}

#[test]
fn thread_status_does_not_project_legacy_sessions_at_request_time() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-legacy-status-list",
        "trace-legacy-status",
        "thread.list",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()["threads"], json!([]));
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_none());
}

#[test]
fn dispatches_session_get_metadata_and_history_for_thread_only_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-create",
        "trace-session-get-thread",
        "thread.create",
        json!({
            "threadId": "thread-backed-session",
            "title": "Thread Backed Session",
            "sessionKey": "thread-backed-session-key",
            "metadata": {
                "workingDirectory": "D:/code/tinybot/thread",
                "lastActivityAt": "2026-07-05T04:00:00Z"
            },
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-append",
        "trace-session-get-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-backed-session",
            "items": [
                {
                    "itemId": "thread-backed-session:item:user",
                    "threadId": "",
                    "runId": "run-thread-backed",
                    "turnId": "turn-thread-backed",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "old UI opens thread-backed session" }
                    }
                },
                {
                    "itemId": "thread-backed-session:item:assistant",
                    "threadId": "",
                    "runId": "run-thread-backed",
                    "turnId": "turn-thread-backed",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "thread history is projected" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-metadata",
        "trace-session-get-thread",
        "session.get_metadata",
        json!({ "session_id": "thread-backed-session-key" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["session_id"],
        "thread-backed-session-key"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["title"],
        "Thread Backed Session"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["threadId"],
        "thread-backed-session"
    );

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-get-thread-history",
        "trace-session-get-thread",
        "session.get_history",
        json!({ "session_id": "thread-backed-session-key" }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["session_id"],
        "thread-backed-session-key"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["role"],
        "user"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "old UI opens thread-backed session"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["role"],
        "assistant"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["content"],
        "thread history is projected"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["updated_at"],
        "2026-07-05T04:00:02Z"
    );
}

#[test]
fn dispatches_session_get_agent_context_from_latest_thread_compaction() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-agent-context-thread-create",
        "trace-agent-context-thread",
        "thread.create",
        json!({
            "threadId": "thread-agent-context",
            "title": "Agent Context",
            "sessionKey": "session-agent-context",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-agent-context-thread-append",
        "trace-agent-context-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-agent-context",
            "items": [
                {
                    "itemId": "thread-agent-context:old-user",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "old user message" }
                    }
                },
                {
                    "itemId": "thread-agent-context:old-assistant",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "old assistant message" }
                    }
                },
                {
                    "itemId": "thread-agent-context:compaction",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:03Z",
                    "kind": {
                        "type": "context_compaction",
                        "payload": {
                            "payload": {
                                "contextCheckpoint": {
                                    "installedReplacementHistory": [
                                        { "role": "assistant", "content": "summary of old conversation" }
                                    ],
                                    "replacementHistory": [
                                        { "role": "assistant", "content": "summary of old conversation" },
                                        {
                                            "role": "assistant",
                                            "content": "",
                                            "tool_calls": [{
                                                "id": "context-read-1",
                                                "type": "function",
                                                "function": {
                                                    "name": "workspace.read_file",
                                                    "arguments": "{\"path\":\"README.md\"}"
                                                }
                                            }]
                                        },
                                        {
                                            "role": "tool",
                                            "tool_call_id": "context-read-1",
                                            "name": "workspace.read_file",
                                            "content": "README contents"
                                        },
                                        { "role": "assistant", "content": "answer from compacted turn" }
                                    ]
                                }
                            }
                        }
                    }
                },
                {
                    "itemId": "thread-agent-context:compacted-answer",
                    "threadId": "",
                    "runId": "run-agent-context",
                    "turnId": "turn-agent-context",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:04Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": { "content": "answer from compacted turn" }
                    }
                },
                {
                    "itemId": "thread-agent-context:new-user",
                    "threadId": "",
                    "runId": "run-agent-context-next",
                    "turnId": "turn-agent-context-next",
                    "sequence": 0,
                    "createdAt": "2026-07-05T04:00:05Z",
                    "kind": {
                        "type": "user_message",
                        "payload": { "content": "next question" }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-agent-context-full-history",
        "trace-agent-context-thread",
        "session.get_history",
        json!({ "session_id": "session-agent-context" }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        4
    );

    let agent_context = router.dispatch(&WorkerRequest::new(
        "req-agent-context-projection",
        "trace-agent-context-thread",
        "session.get_agent_context",
        json!({ "session_id": "session-agent-context" }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"],
        json!([
            { "role": "assistant", "content": "summary of old conversation" },
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "context-read-1",
                    "type": "function",
                    "function": {
                        "name": "workspace.read_file",
                        "arguments": "{\"path\":\"README.md\"}"
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "context-read-1",
                "name": "workspace.read_file",
                "content": "README contents"
            },
            {
                "role": "assistant",
                "content": "answer from compacted turn"
            },
            {
                "role": "user",
                "content": "next question",
                "timestamp": "2026-07-05T04:00:05Z",
                "turnId": "turn-agent-context-next"
            }
        ])
    );
}

#[test]
fn dispatches_session_get_history_reads_thread_tail() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-tail-thread-create",
        "trace-session-tail-thread",
        "thread.create",
        json!({
            "threadId": "thread-tail-history",
            "title": "Tail History",
            "sessionKey": "thread-tail-session",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let items = (0..205)
        .map(|index| {
            json!({
                "itemId": format!("thread-tail-history:item:{index}"),
                "threadId": "",
                "runId": "run-thread-tail",
                "turnId": "turn-thread-tail",
                "sequence": 0,
                "createdAt": format!("2026-07-05T05:{:02}:{:02}Z", index / 60, index % 60),
                "kind": {
                    "type": "user_message",
                    "payload": { "content": format!("message-{index}") }
                }
            })
        })
        .collect::<Vec<_>>();
    let append = router.dispatch(&WorkerRequest::new(
        "req-session-tail-thread-append",
        "trace-session-tail-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-tail-history",
            "items": items
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-tail-history",
        "trace-session-tail-thread",
        "session.get_history",
        json!({ "session_id": "thread-tail-session", "limit": 2 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"],
        json!([
            {
                "role": "user",
                "content": "message-203",
                "timestamp": "2026-07-05T05:03:23Z",
                "turnId": "turn-thread-tail"
            },
            {
                "role": "user",
                "content": "message-204",
                "timestamp": "2026-07-05T05:03:24Z",
                "turnId": "turn-thread-tail"
            }
        ])
    );
}

#[test]
fn dispatches_session_get_history_projects_thread_message_metadata_and_usage() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );

    let create = router.dispatch(&WorkerRequest::new(
        "req-session-rich-thread-create",
        "trace-session-rich-thread",
        "thread.create",
        json!({
            "threadId": "thread-rich-history",
            "title": "Rich History",
            "sessionKey": "thread-rich-session",
            "source": "user"
        }),
    ));
    assert_eq!(create.error, None);

    let append = router.dispatch(&WorkerRequest::new(
        "req-session-rich-thread-append",
        "trace-session-rich-thread",
        "thread.append_items",
        json!({
            "threadId": "thread-rich-history",
            "items": [
                {
                    "itemId": "thread-rich-history:user",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:01Z",
                    "kind": {
                        "type": "user_message",
                        "payload": {
                            "messageId": "user-rich",
                            "content": "load rich history"
                        }
                    }
                },
                {
                    "itemId": "thread-rich-history:assistant",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:02Z",
                    "kind": {
                        "type": "assistant_message_completed",
                        "payload": {
                            "messageId": "assistant-rich",
                            "content": "rich history loaded",
                            "references": [{ "id": "ref-1", "kind": "memory", "title": "Memory" }],
                            "metadata": { "finishReason": "stop" }
                        }
                    }
                },
                {
                    "itemId": "thread-rich-history:terminal",
                    "threadId": "",
                    "runId": "run-rich-history",
                    "turnId": "turn-rich-history",
                    "sequence": 0,
                    "createdAt": "2026-07-05T06:00:03Z",
                    "kind": {
                        "type": "agent_run_completed",
                        "payload": {
                            "runId": "run-rich-history",
                            "tokenUsageInfo": {
                                "totalTokenUsage": {
                                    "inputTokens": 0,
                                    "cachedInputTokens": 0,
                                    "outputTokens": 0,
                                    "reasoningOutputTokens": 0,
                                    "totalTokens": 172
                                },
                                "lastTokenUsage": {
                                    "inputTokens": 10,
                                    "cachedInputTokens": 0,
                                    "outputTokens": 162,
                                    "reasoningOutputTokens": 41,
                                    "totalTokens": 172
                                },
                                "modelContextWindow": 128000
                            }
                        }
                    }
                }
            ]
        }),
    ));
    assert_eq!(append.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-rich-history",
        "trace-session-rich-thread",
        "session.get_history",
        json!({ "session_id": "thread-rich-session" }),
    ));

    assert_eq!(history.error, None);
    let messages = &history.result.as_ref().unwrap()["messages"];
    assert_eq!(messages[0]["messageId"], "user-rich");
    assert_eq!(messages[1]["messageId"], "assistant-rich");
    assert_eq!(messages[1]["references"][0]["id"], "ref-1");
    assert_eq!(messages[1]["metadata"]["finishReason"], "stop");
    assert_eq!(messages[1]["usage"]["contextWindowTokens"], 128000);
    assert_eq!(messages[1]["usage"]["contextWindowUsedTokens"], 172);
    assert_eq!(messages[1]["usage"]["totalTokens"], 172);
    assert_eq!(messages[1]["usage"]["completionTokens"], 162);
}

#[test]
fn session_get_history_does_not_read_in_memory_legacy_session() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "second" }
        ],
        "user_profile": { "name": "Ada" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 1 }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result, Some(Value::Null));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_thread_rollback_as_an_append_only_rollout_marker() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    for (run_id, user, assistant, checkpoint) in [
        ("rollback-run-1", "first user", "first assistant", None),
        (
            "rollback-run-2",
            "second user",
            "second assistant",
            Some(json!({
                "replacementHistory": [
                    { "role": "user", "content": "compacted second turn" },
                    { "role": "assistant", "content": "summary after second turn" }
                ],
                "checkpointStage": "finalized"
            })),
        ),
    ] {
        let mut params = json!({
            "session_id": "thread-rollout-rollback",
            "run_id": run_id,
            "messages": [
                { "role": "user", "content": user },
                { "role": "assistant", "content": assistant }
            ]
        });
        if let Some(checkpoint) = checkpoint {
            params["contextMetadata"] = json!({ "contextCheckpoint": checkpoint });
        }
        let persisted = router.dispatch(&WorkerRequest::new(
            format!("req-{run_id}"),
            "trace-thread-rollout-rollback",
            "session.persist_turn",
            params,
        ));
        assert_eq!(persisted.error, None);
    }

    let rolled_back = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback",
        "trace-thread-rollout-rollback",
        "thread.rollback",
        json!({
            "threadId": "thread-rollout-rollback",
            "numTurns": 1
        }),
    ));
    assert_eq!(rolled_back.error, None);
    let result = rolled_back.result.as_ref().unwrap();
    assert_eq!(result["threadId"], "thread-rollout-rollback");
    assert_eq!(result["numTurns"], 1);
    assert_eq!(result["remainingMessageCount"], 2);
    assert_eq!(result["contextCheckpointRetained"], false);

    for method in ["session.get_history", "session.get_agent_context"] {
        let projection = router.dispatch(&WorkerRequest::new(
            format!("req-thread-rollout-rollback-{method}"),
            "trace-thread-rollout-rollback",
            method,
            json!({ "session_id": "thread-rollout-rollback" }),
        ));
        assert_eq!(projection.error, None);
        let messages = projection.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], "first user");
        assert_eq!(messages[1]["content"], "first assistant");
    }

    let metadata = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback-metadata",
        "trace-thread-rollout-rollback",
        "session.get_metadata",
        json!({ "session_id": "thread-rollout-rollback" }),
    ));
    let rollout_path = metadata.result.as_ref().unwrap()["extra"]["threadPath"]
        .as_str()
        .unwrap();
    let rollout = std::fs::read_to_string(rollout_path).unwrap();
    assert!(rollout.contains("second user"));
    assert!(rollout.contains("\"type\":\"thread_rolled_back\""));
    assert!(rollout.contains("\"num_turns\":1"));

    let consistency = router.dispatch(&WorkerRequest::new(
        "req-thread-rollout-rollback-consistency",
        "trace-thread-rollout-rollback",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn thread_rollback_rejects_an_in_progress_turn() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let started = router.dispatch(&WorkerRequest::new(
        "req-thread-rollback-start",
        "trace-thread-rollback-start",
        "rollout.append_turn_context",
        json!({
            "sessionId": "thread-rollback-active",
            "context": {
                "turn_id": "turn-rollback-active",
                "cwd": "",
                "approval_policy": {},
                "sandbox_policy": {},
                "model": "fixture-model",
                "summary": {}
            }
        }),
    ));
    assert_eq!(started.error, None);

    let rollback = router.dispatch(&WorkerRequest::new(
        "req-thread-rollback-active",
        "trace-thread-rollback-active",
        "thread.rollback",
        json!({
            "threadId": "thread-rollback-active",
            "numTurns": 1
        }),
    ));
    assert!(rollback.error.as_ref().is_some_and(|error| {
        error
            .message
            .contains("cannot rollback while a turn is in progress")
    }));
}

#[test]
fn dispatches_session_get_history_does_not_project_legacy_history_on_read() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "second" }
        ],
        "user_profile": { "name": "Ada" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    );
    let response = router.dispatch(&WorkerRequest::new(
        "req-session-history-project",
        "trace-history-project",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 80 }),
    ));
    assert_eq!(response.error, None);
    assert_eq!(response.result, Some(Value::Null));
}

#[test]
fn dispatches_session_delete_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let create_thread = router.dispatch(&WorkerRequest::new(
        "req-thread-before-session-delete",
        "trace-1",
        "thread.create",
        json!({
            "title": "Linked session",
            "sessionKey": "session-1"
        }),
    ));
    assert_eq!(create_thread.error, None);
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.delete",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "session_id": "session-1",
            "deleted": true
        }))
    );
    assert!(response.error.is_none());

    let session_list = router.dispatch(&WorkerRequest::new(
        "req-session-list-after-session-delete",
        "trace-1",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(session_list.error, None);
    assert_eq!(session_list.result, Some(json!([])));
}

#[test]
fn session_patch_metadata_does_not_mutate_in_memory_legacy_session() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({ "metadata": { "pinned": false, "topic": "old" } });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.patch_metadata",
        json!({
            "session_id": "session-1",
            "metadata": { "pinned": true, "title": "Patched title" }
        }),
    );

    let response = router.dispatch(&request);

    assert!(response.result.is_none());
    assert_eq!(
        response.error.as_ref().map(|error| error.message.as_str()),
        Some("session metadata not found")
    );
}

#[test]
fn session_patch_user_profile_does_not_mutate_in_memory_legacy_session() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "user_profile": { "name": "Ada", "preferences": ["short answers"] },
        "metadata": { "entity_extractor_last_turn_hash": "old-hash", "topic": "native" }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.patch_user_profile",
        json!({
            "session_id": "session-1",
            "user_profile": {
                "name": "Ada",
                "preferences": ["short answers", "code examples"]
            },
            "metadata": { "entity_extractor_last_turn_hash": "new-hash" }
        }),
    );

    let response = router.dispatch(&request);

    assert!(response.result.is_none());
    assert_eq!(
        response.error.as_ref().map(|error| error.message.as_str()),
        Some("session metadata not found")
    );
}

#[test]
fn dispatches_workspace_read_bootstrap_files_request() {
    let fixture = WorkspaceFixture::new();
    fixture.write("AGENTS.md", "agent rules");
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::FsWorkspaceRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "workspace.read_bootstrap_files",
        json!({ "files": ["AGENTS.md", "TOOLS.md"] }),
    );

    let response = router.dispatch(&request);

    let result = response.result.expect("bootstrap result should be present");
    assert_eq!(result["missing"], json!(["TOOLS.md"]));
    let files = result["files"]
        .as_array()
        .expect("files should be an array");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "AGENTS.md");
    assert_eq!(files[0]["contents"], "agent rules");
    assert!(files[0]["updated_at"].is_string());
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_checkpoint_requests() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let set_request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.set_checkpoint",
        json!({
            "session_id": "session-1",
            "checkpoint": {
                "phase": "awaiting_tools",
                "runId": "run-session-checkpoint",
                "checkpointId": "checkpoint-session-route"
            }
        }),
    );
    let clear_request = WorkerRequest::new(
        "req-2",
        "trace-1",
        "session.clear_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let set_response = router.dispatch(&set_request);
    let clear_response = router.dispatch(&clear_request);

    assert_eq!(
        set_response.result.as_ref().unwrap()["extra"]["runtime_checkpoint"],
        json!({
            "phase": "awaiting_tools",
            "runId": "run-session-checkpoint",
            "checkpointId": "checkpoint-session-route"
        })
    );
    assert_removed_persistence_paths_absent(&fixture.root);
    assert!(clear_response.result.as_ref().unwrap()["extra"]
        .get("runtime_checkpoint")
        .is_none());
    assert!(set_response.error.is_none());
    assert!(clear_response.error.is_none());
}

#[test]
fn dispatches_session_get_checkpoint_request() {
    let fixture = WorkspaceFixture::new();
    let mut seed_router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let seed = seed_router.dispatch(&WorkerRequest::new(
        "req-seed-checkpoint",
        "trace-seed-checkpoint",
        "session.set_checkpoint",
        json!({
            "session_id": "session-1",
            "checkpoint": {
                "runId": "run-1",
                "phase": "awaiting_tools",
                "iteration": 1
            }
        }),
    ));
    assert_eq!(seed.error, None);

    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "runId": "run-1",
            "phase": "awaiting_tools",
            "iteration": 1
        }))
    );
    assert!(response.error.is_none());
}

#[test]
fn session_get_checkpoint_does_not_fall_back_to_in_memory_legacy_checkpoint() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "runtime_checkpoint": {
            "runId": "run-legacy-checkpoint",
            "phase": "awaiting_tools",
            "iteration": 2
        }
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-legacy-checkpoint",
        "trace-legacy-checkpoint",
        "session.get_checkpoint",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result, Some(Value::Null));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_missing_session_checkpoint_as_null() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.get_checkpoint",
        json!({ "session_id": "desktop-session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(response.result, Some(json!(null)));
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_append_messages_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session_fixture()],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.append_messages",
        json!({
            "session_id": "session-1",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ]
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["extra"]["messages"],
        json!([
            { "role": "user", "content": "hello" },
            { "role": "assistant", "content": "done" }
        ])
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_clear_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "hello" },
            { "role": "assistant", "content": "done" }
        ],
        "runtime_checkpoint": { "phase": "awaiting_tools" },
        "user_profile": { "name": "Ada" },
        "last_consolidated": 1
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    router
        .thread_log
        .persist_session_turn(
            "session-1",
            "run-clear",
            vec![
                json!({ "role": "user", "content": "hello" }),
                json!({ "role": "assistant", "content": "done" }),
            ],
            None,
        )
        .unwrap();
    router
        .thread_log
        .set_agent_run_checkpoint(
            "session-1",
            "run-clear",
            json!({ "runId": "run-clear", "phase": "awaiting_tools" }),
        )
        .unwrap();
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.clear",
        json!({ "session_id": "session-1" }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["messages_before"],
        json!(2)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["messages_after"],
        json!(0)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["checkpoint_cleared"],
        json!(true)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["session"]["extra"]["messages"],
        json!([])
    );
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_trim_request() {
    let fixture = WorkspaceFixture::new();
    let mut session = session_fixture();
    session.extra = json!({
        "messages": [
            { "role": "user", "content": "old" },
            { "role": "assistant", "content": "old answer" },
            { "role": "user", "content": "recent" },
            { "role": "assistant", "content": "recent answer" }
        ],
        "last_consolidated": 1
    });
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![session],
        20,
        CapabilityPolicy::new([WorkerCapability::SessionWrite]),
    );
    router
        .thread_log
        .persist_session_turn(
            "session-1",
            "run-trim",
            vec![
                json!({ "role": "user", "content": "old" }),
                json!({ "role": "assistant", "content": "old answer" }),
                json!({ "role": "user", "content": "recent" }),
                json!({ "role": "assistant", "content": "recent answer" }),
            ],
            None,
        )
        .unwrap();
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.trim",
        json!({ "session_id": "session-1", "keep_recent_messages": 1 }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result.as_ref().unwrap()["messages_before"],
        json!(4)
    );
    assert_eq!(
        response.result.as_ref().unwrap()["messages_after"],
        json!(2)
    );
    let messages = response.result.as_ref().unwrap()["session"]["extra"]["messages"]
        .as_array()
        .unwrap();
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["content"], "recent");
    assert_eq!(messages[1]["role"], "assistant");
    assert_eq!(messages[1]["content"], "recent answer");
    assert!(response.error.is_none());
}

#[test]
fn dispatches_session_persist_turn_request() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new(
        fixture.root.clone(),
        json!({}),
        vec![],
        20,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    );
    let request = WorkerRequest::new(
        "req-1",
        "trace-1",
        "session.persist_turn",
        json!({
            "session_id": "session-1",
            "run_id": "run-1",
            "messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "clear_checkpoint": true,
            "contextMetadata": {
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            },
            "context_metadata": {
                "historyMessageCount": 1,
                "bridge": {
                    "missingSession": false
                }
            }
        }),
    );

    let response = router.dispatch(&request);

    assert_eq!(
        response.result,
        Some(json!({
            "session_id": "session-1",
            "messages_before": 0,
            "messages_after": 2,
            "saved_message_count": 2,
            "saved_messages": [
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "done" }
            ],
            "checkpoint_cleared": false,
            "duplicate_message_count": 0,
            "truncated_tool_result_count": 0,
            "omitted_side_effects": [
                "conversation_evidence",
                "memory_extraction",
                "consolidation",
                "user_profile_update"
            ]
        }))
    );
    assert!(response.error.is_none());

    let history = router.dispatch(&WorkerRequest::new(
        "req-session-persist-history",
        "trace-1",
        "session.get_history",
        json!({ "session_id": "session-1", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "hello"
    );
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["content"],
        "done"
    );
}

#[test]
fn persisted_compaction_replaces_agent_context_but_preserves_transcript() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let old_turn = router.dispatch(&WorkerRequest::new(
        "req-compact-old-turn",
        "trace-compact-persistence",
        "session.persist_turn",
        json!({
            "session_id": "session-compact-persistence",
            "run_id": "run-compact-old-turn",
            "messages": [
                { "role": "user", "content": "old user", "messageId": "compact-old-user" },
                { "role": "assistant", "content": "old answer", "messageId": "compact-old-answer" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(old_turn.error, None);

    let compacted_turn = router.dispatch(&WorkerRequest::new(
        "req-compact-current-turn",
        "trace-compact-persistence",
        "session.persist_turn",
        json!({
            "session_id": "session-compact-persistence",
            "run_id": "run-compact-current-turn",
            "messages": [
                { "role": "user", "content": "current user", "messageId": "compact-current-user" },
                { "role": "assistant", "content": "current answer", "messageId": "compact-current-answer" }
            ],
            "clear_checkpoint": false,
            "context_metadata": {
                "contextCheckpoint": {
                    "schemaVersion": 1,
                    "replacementHistory": [
                        { "role": "assistant", "content": "summary of old turn" },
                        { "role": "user", "content": "current user" },
                        { "role": "assistant", "content": "current answer" }
                    ]
                }
            }
        }),
    ));
    assert_eq!(compacted_turn.error, None);
    assert_eq!(compacted_turn.result.as_ref().unwrap()["messages_after"], 3);

    let history = router.dispatch(&WorkerRequest::new(
        "req-compact-transcript",
        "trace-compact-persistence",
        "session.get_history",
        json!({ "session_id": "session-compact-persistence", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["old user", "old answer", "current user", "current answer"]
    );

    let agent_context = router.dispatch(&WorkerRequest::new(
        "req-compact-agent-context",
        "trace-compact-persistence",
        "session.get_agent_context",
        json!({ "session_id": "session-compact-persistence", "limit": 80 }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"],
        json!([
            { "role": "assistant", "content": "summary of old turn" },
            { "role": "user", "content": "current user" },
            { "role": "assistant", "content": "current answer" }
        ])
    );
}

#[test]
fn persists_session_turn_to_thread_log() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-thread-log-persist",
        "trace-thread-log-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-thread-log-1",
            "run_id": "run-1",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-1" },
                { "role": "assistant", "content": "hi", "messageId": "assistant-1" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let history = router.dispatch(&WorkerRequest::new(
        "req-thread-log-history",
        "trace-thread-log-history",
        "session.get_history",
        json!({ "session_id": "session-thread-log-1", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    let messages = &history.result.as_ref().unwrap()["messages"];
    assert_eq!(messages.as_array().unwrap().len(), 2);
    assert_eq!(messages[0]["messageId"], "user-1");
    assert_eq!(messages[1]["messageId"], "assistant-1");
}

#[test]
fn session_persist_turn_does_not_write_legacy_session_or_thread_stores() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-thread-log-only-persist",
        "trace-thread-log-only-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-thread-log-only",
            "run_id": "run-thread-log-only",
            "messages": [
                { "role": "user", "content": "canonical only" },
                { "role": "assistant", "content": "saved in thread log" }
            ],
            "clear_checkpoint": false
        }),
    ));

    assert_eq!(persist.error, None);
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    assert!(first_thread_log_file_under(&fixture.root, "threads").is_some());
    assert_removed_persistence_paths_absent(&fixture.root);
}

#[test]
fn rollout_native_session_mutations_survive_restart_without_legacy_stores() {
    let fixture = WorkspaceFixture::new();
    let policy = CapabilityPolicy::new([
        WorkerCapability::SessionWrite,
        WorkerCapability::SessionMetadataRead,
    ]);
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            policy.clone(),
        )
        .unwrap();
        let appended = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-append",
            "trace-rollout-session",
            "session.append_messages",
            json!({
                "session_id": "session-rollout-native",
                "messages": [
                    { "role": "user", "content": "old" },
                    { "role": "assistant", "content": "old answer" },
                    { "role": "user", "content": "recent" },
                    { "role": "assistant", "content": "recent answer" }
                ]
            }),
        ));
        assert_eq!(appended.error, None);

        let profile = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-profile",
            "trace-rollout-session",
            "session.patch_user_profile",
            json!({
                "session_id": "session-rollout-native",
                "user_profile": { "name": "Ada" },
                "metadata": { "profileSource": "test" }
            }),
        ));
        assert_eq!(profile.error, None);

        let trimmed = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-trim",
            "trace-rollout-session",
            "session.trim",
            json!({
                "session_id": "session-rollout-native",
                "keep_recent_messages": 1
            }),
        ));
        assert_eq!(trimmed.error, None);
        assert_eq!(trimmed.result.as_ref().unwrap()["messages_after"], 2);

        for (request_id, content, completed, steps) in [
            (
                "req-rollout-session-progress-1",
                "first progress",
                0,
                json!([
                    { "step": "Inspect session", "status": "in_progress" },
                    { "step": "Finish session", "status": "pending" }
                ]),
            ),
            (
                "req-rollout-session-progress-2",
                "updated progress",
                1,
                json!([
                    { "step": "Inspect session", "status": "completed" },
                    { "step": "Finish session", "status": "in_progress" }
                ]),
            ),
        ] {
            let progress = router.dispatch(&WorkerRequest::new(
                request_id,
                "trace-rollout-session",
                "session.task_progress.upsert",
                json!({
                    "session_id": "session-rollout-native",
                    "plan_id": "plan-rollout-native",
                    "content": content,
                    "progress": {
                        "completed": completed,
                        "total": 2,
                        "steps": steps
                    }
                }),
            ));
            assert_eq!(progress.error, None);
        }

        let metadata = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-metadata",
            "trace-rollout-session",
            "session.patch_metadata",
            json!({
                "session_id": "session-rollout-native",
                "metadata": { "title": "Rollout native session", "pinned": true }
            }),
        ));
        assert_eq!(metadata.error, None);

        for session_id in ["session-rollout-clear", "session-rollout-delete"] {
            let appended = router.dispatch(&WorkerRequest::new(
                format!("req-{session_id}-append"),
                "trace-rollout-session-lifecycle",
                "session.append_messages",
                json!({
                    "session_id": session_id,
                    "messages": [
                        { "role": "user", "content": "lifecycle message" },
                        { "role": "assistant", "content": "lifecycle answer" }
                    ]
                }),
            ));
            assert_eq!(appended.error, None);
        }
        let cleared = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-clear",
            "trace-rollout-session-lifecycle",
            "session.clear",
            json!({ "session_id": "session-rollout-clear" }),
        ));
        assert_eq!(cleared.error, None);
        let deleted = router.dispatch(&WorkerRequest::new(
            "req-rollout-session-delete",
            "trace-rollout-session-lifecycle",
            "session.delete",
            json!({ "session_id": "session-rollout-delete" }),
        ));
        assert_eq!(deleted.error, None);
        assert_eq!(deleted.result.as_ref().unwrap()["deleted"], true);
    }

    let mut restarted = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        policy,
    )
    .unwrap();
    let history = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-history-after-restart",
        "trace-rollout-session",
        "session.get_history",
        json!({ "session_id": "session-rollout-native", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    let history = history.result.unwrap();
    assert_eq!(history["user_profile"], json!({ "name": "Ada" }));
    assert_eq!(
        history["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|message| message["content"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["recent", "recent answer"]
    );
    let agent_context = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-context-after-restart",
        "trace-rollout-session",
        "session.get_agent_context",
        json!({ "session_id": "session-rollout-native", "limit": 80 }),
    ));
    assert_eq!(agent_context.error, None);
    assert_eq!(
        agent_context.result.as_ref().unwrap()["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["_task_plan_id"] == "plan-rollout-native")
            .count(),
        1
    );
    let metadata = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-metadata-after-restart",
        "trace-rollout-session",
        "session.get_metadata",
        json!({ "session_id": "session-rollout-native" }),
    ));
    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["title"],
        "Rollout native session"
    );
    assert_eq!(
        metadata.result.as_ref().unwrap()["extra"]["metadata"]["pinned"],
        true
    );
    let cleared_history = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-clear-after-restart",
        "trace-rollout-session-lifecycle",
        "session.get_history",
        json!({ "session_id": "session-rollout-clear", "limit": 80 }),
    ));
    assert_eq!(cleared_history.error, None);
    assert_eq!(
        cleared_history.result.as_ref().unwrap()["messages"],
        json!([])
    );
    let sessions = restarted.dispatch(&WorkerRequest::new(
        "req-rollout-session-list-after-restart",
        "trace-rollout-session-lifecycle",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(sessions.error, None);
    assert!(!sessions
        .result
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .any(|session| session["session_id"] == "session-rollout-delete"));

    let rollout_path = PathBuf::from(
        metadata.result.as_ref().unwrap()["extra"]["threadPath"]
            .as_str()
            .unwrap(),
    );
    let rollout = std::fs::read_to_string(rollout_path).unwrap();
    assert!(rollout.contains("\"type\":\"session_trimmed\""));
    assert!(rollout.contains("\"_task_plan_id\""));
    assert_removed_persistence_paths_absent(&fixture.root);
}

#[test]
fn agent_run_semantic_persistence_rejects_transient_events() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let record = json!({
        "sessionId": "session-agent-log-only",
        "runId": "run-agent-log-only",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-08T10:00:00Z",
        "updatedAt": "2026-07-08T10:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-upsert",
        "trace-agent-log-only",
        "agent_run.start",
        json!({ "record": record }),
    ));
    let append_semantic = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-trace",
        "trace-agent-log-only",
        "agent_run.append_semantic_batch",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only",
            "events": [{
                "eventId": "trace-delta-1",
                "eventName": "agent.delta",
                "payload": { "delta": "hel" }
            }, {
                "eventId": "trace-delta-2",
                "eventName": "agent.delta",
                "payload": { "delta": "lo" }
            }]
        }),
    ));
    let completed = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-complete",
        "trace-agent-log-only",
        "agent_run.mark_completed",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only",
            "stop_reason": "final_response",
            "final_content": "hello"
        }),
    ));
    let get = router.dispatch(&WorkerRequest::new(
        "req-agent-log-only-get",
        "trace-agent-log-only",
        "agent_run.get",
        json!({
            "session_id": "session-agent-log-only",
            "run_id": "run-agent-log-only"
        }),
    ));

    assert_eq!(upsert.error, None);
    assert!(append_semantic.error.is_some());
    assert_eq!(completed.error, None);
    assert_eq!(get.error, None);
    assert_eq!(get.result.as_ref().unwrap()["status"], "completed");
    assert!(get.result.as_ref().unwrap().get("traceEvents").is_none());
    assert_removed_persistence_paths_absent(&fixture.root);
    assert!(fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite")
        .exists());
    let rollout_path =
        first_thread_log_file_under(&fixture.root, "threads").expect("rollout should exist");
    let upsert_record = std::fs::read_to_string(rollout_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .find(|line| line["type"] == "event_msg" && line["payload"]["type"] == "turn_started")
        .map(|line| line["payload"]["payload"]["agentRun"].clone())
        .expect("agent run seed should be persisted");
    assert_eq!(upsert_record["sessionId"], "session-agent-log-only");
    assert_eq!(upsert_record["runId"], "run-agent-log-only");
    for derived_field in [
        "status",
        "phase",
        "updatedAt",
        "completedAt",
        "stopReason",
        "currentIteration",
        "traceMessages",
        "completedToolResults",
        "pendingToolCalls",
        "checkpoint",
        "artifacts",
        "usage",
        "tokenUsageInfo",
        "error",
    ] {
        assert!(
            upsert_record.get(derived_field).is_none(),
            "turn_started seed must not persist derived field `{derived_field}`"
        );
    }
}

#[test]
fn agent_run_reasoning_survives_canonical_rollout_reload() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let record = json!({
        "sessionId": "session-reasoning-reload",
        "runId": "run-reasoning-reload",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-19T10:00:00Z",
        "updatedAt": "2026-07-19T10:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });
    let upsert = router.dispatch(&WorkerRequest::new(
        "req-reasoning-reload-upsert",
        "trace-reasoning-reload",
        "agent_run.start",
        json!({ "record": record }),
    ));
    assert_eq!(upsert.error, None);

    for index in 0..70 {
        let padding = router.dispatch(&WorkerRequest::new(
            format!("req-reasoning-reload-padding-{index}"),
            "trace-reasoning-reload",
            "session.patch_metadata",
            json!({
                "session_id": "session-reasoning-reload",
                "metadata": { "reloadPadding": index }
            }),
        ));
        assert_eq!(padding.error, None);
    }

    let append_semantic = router.dispatch(&WorkerRequest::new(
        "req-reasoning-reload-trace",
        "trace-reasoning-reload",
        "agent_run.append_semantic_batch",
        json!({
            "session_id": "session-reasoning-reload",
            "run_id": "run-reasoning-reload",
            "events": [{
                "eventId": "reasoning-reload-reasoning-completed",
                "eventName": "agent.reasoning.completed",
                "sequence": 1,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "summary": "Inspect first.",
                    "modelCallId": "provider-1",
                    "reasoningId": "reasoning-1"
                }
            }, {
                "eventId": "reasoning-reload-tool-a",
                "eventName": "agent.tool_call.delta",
                "sequence": 2,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "toolCallId": "call-a",
                    "toolName": "workspace.read_file",
                    "argumentsDelta": "{\"path\":\"A.md\"}"
                }
            }, {
                "eventId": "reasoning-reload-tool-b",
                "eventName": "agent.tool_call.delta",
                "sequence": 3,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "toolCallId": "call-b",
                    "toolName": "workspace.read_file",
                    "argumentsDelta": "{\"path\":\"B.md\"}"
                }
            }, {
                "eventId": "reasoning-reload-result-b",
                "eventName": "agent.tool.result",
                "sequence": 4,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "toolCallId": "call-b",
                    "toolName": "workspace.read_file",
                    "content": "B"
                }
            }, {
                "eventId": "reasoning-reload-result-a",
                "eventName": "agent.tool.result",
                "sequence": 5,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "toolCallId": "call-a",
                    "toolName": "workspace.read_file",
                    "content": "A"
                }
            }, {
                "eventId": "reasoning-reload-completed",
                "eventName": "agent.message.completed",
                "sequence": 6,
                "turnId": "run-reasoning-reload",
                "payload": {
                    "content": "Done.",
                    "messageId": "assistant-reasoning-reload",
                    "messagePhase": "final_answer",
                    "modelCallId": "provider-1"
                }
            }]
        }),
    ));
    assert_eq!(append_semantic.error, None);
    let completed = router.dispatch(&WorkerRequest::new(
        "req-reasoning-reload-complete",
        "trace-reasoning-reload",
        "agent_run.mark_completed",
        json!({
            "session_id": "session-reasoning-reload",
            "run_id": "run-reasoning-reload",
            "stop_reason": "final_response",
            "final_content": "Done."
        }),
    ));
    assert_eq!(completed.error, None);
    drop(router);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");

    let mut restarted = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let runtime_state = restarted.dispatch(&WorkerRequest::new(
        "req-reasoning-reload-state",
        "trace-reasoning-reload",
        "agent_run.runtime_state",
        json!({
            "session_id": "session-reasoning-reload",
            "run_id": "run-reasoning-reload"
        }),
    ));
    assert_eq!(runtime_state.error, None);
    let runtime_events = runtime_state.result.as_ref().unwrap()["runtimeEvents"]
        .as_array()
        .expect("runtime events should be an array");
    assert!(runtime_events
        .windows(2)
        .all(|pair| pair[0]["sequence"].as_u64() < pair[1]["sequence"].as_u64()));
    assert_eq!(
        runtime_events
            .iter()
            .filter(|event| event["eventName"] == "agent.reasoning.completed")
            .count(),
        1
    );
    assert_eq!(
        runtime_events
            .iter()
            .filter(|event| event["eventName"] == "agent.message.completed")
            .count(),
        1
    );
    assert_eq!(
        runtime_events
            .iter()
            .filter(|event| event["eventName"] == "agent.tool_call.delta")
            .count(),
        2
    );
    assert_eq!(
        runtime_events
            .iter()
            .filter(|event| event["eventName"] == "agent.tool.result")
            .count(),
        2
    );
    let items = runtime_state.result.as_ref().unwrap()["timeline"]["items"]
        .as_array()
        .expect("timeline items should be an array");
    let reasoning = items
        .iter()
        .filter(|item| item["kind"] == "reasoning")
        .collect::<Vec<_>>();
    assert_eq!(reasoning.len(), 1);
    assert_eq!(reasoning[0]["data"]["summary"], "Inspect first.");
    let tools = items
        .iter()
        .filter(|item| item["kind"] == "tool_call")
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 2);
    assert!(tools
        .iter()
        .all(|item| item["status"] == "completed" && item["data"]["status"] == "completed"));
    assert_eq!(items.last().unwrap()["kind"], "assistant_message");
    assert_eq!(items.last().unwrap()["data"]["content"], "Done.");
}

#[test]
fn agent_run_semantic_append_updates_projection_and_keeps_index_clean() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let record = json!({
        "sessionId": "session-trace-state-index",
        "runId": "run-trace-state-index",
        "status": "running",
        "phase": "active_turn",
        "startedAt": "2026-07-08T10:00:00Z",
        "updatedAt": "2026-07-08T10:00:00Z",
        "completedAt": null,
        "stopReason": null,
        "model": "fixture-model",
        "provider": "fixture",
        "maxIterations": 4,
        "currentIteration": 0,
        "conversationMessageIds": [],
        "traceMessages": [],
        "completedToolResults": [],
        "pendingToolCalls": [],
        "checkpoint": null,
        "artifacts": [],
        "usage": [],
        "error": null
    });

    let upsert = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-upsert",
        "trace-state-index",
        "agent_run.start",
        json!({ "record": record }),
    ));
    assert_eq!(upsert.error, None);
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let before_updated_at = thread_state_updated_at(&state_path, "session-trace-state-index");
    thread::sleep(Duration::from_millis(5));

    let append_semantic = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-append",
        "trace-state-index",
        "agent_run.append_semantic_batch",
        json!({
            "session_id": "session-trace-state-index",
            "run_id": "run-trace-state-index",
            "events": [{
                "eventId": "semantic-state-index-message",
                "eventName": "agent.message.completed",
                "turnId": "run-trace-state-index",
                "payload": {
                    "content": "completed",
                    "messageId": "assistant-state-index",
                    "messagePhase": "final_answer"
                }
            }]
        }),
    ));
    assert_eq!(append_semantic.error, None);

    let after_updated_at = thread_state_updated_at(&state_path, "session-trace-state-index");
    assert!(after_updated_at > before_updated_at);
    let context = router
        .thread_log
        .get_agent_context("session-trace-state-index", 50)
        .unwrap()
        .unwrap();
    assert_eq!(context.messages.len(), 1);
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-trace-state-index-consistency",
        "trace-state-index",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
    assert!(append_semantic
        .result
        .as_ref()
        .unwrap()
        .get("traceEvents")
        .is_none());
}

#[test]
fn persists_thread_log_token_count_and_replays_usage() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();

    let persist = router.dispatch(&WorkerRequest::new(
        "req-token-count-persist",
        "trace-token-count-persist",
        "session.persist_turn",
        json!({
            "session_id": "session-token-count",
            "run_id": "run-token-count",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-token" },
                { "role": "assistant", "content": "hi", "messageId": "assistant-token" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    router
        .thread_log
        .append_token_count(
            "session-token-count",
            crate::threads::rollout::store::TokenUsageInfo {
                total_token_usage: crate::threads::rollout::store::TokenUsage {
                    input_tokens: 1010,
                    cached_input_tokens: 0,
                    output_tokens: 162,
                    reasoning_output_tokens: 0,
                    total_tokens: 1172,
                },
                last_token_usage: crate::threads::rollout::store::TokenUsage {
                    input_tokens: 10,
                    cached_input_tokens: 0,
                    output_tokens: 162,
                    reasoning_output_tokens: 0,
                    total_tokens: 172,
                },
                model_context_window: Some(128000),
            },
        )
        .unwrap();

    let history = router.dispatch(&WorkerRequest::new(
        "req-token-count-history",
        "trace-token-count-history",
        "session.get_history",
        json!({ "session_id": "session-token-count", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    let assistant = &history.result.as_ref().unwrap()["messages"][1];
    assert_eq!(assistant["usage"]["contextWindowUsedTokens"], 172);
    assert_eq!(assistant["usage"]["contextWindowTokens"], 128000);
    assert_eq!(assistant["usage"]["totalTokens"], 172);
    assert_eq!(
        assistant["tokenUsageInfo"]["lastTokenUsage"]["totalTokens"],
        172
    );

    let list = router.dispatch(&WorkerRequest::new(
        "req-token-count-list",
        "trace-token-count-history",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"],
        1172
    );
}

#[test]
fn thread_log_history_survives_router_restart() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
                "req-restart-persist",
                "trace-restart-persist",
                "session.persist_turn",
                json!({
                    "session_id": "session-restart",
                    "run_id": "run-restart",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-restart" },
                        { "role": "assistant", "content": "persisted", "messageId": "assistant-restart" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
        assert_eq!(persist.error, None);
    }

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-restart-history",
        "trace-restart-history",
        "session.get_history",
        json!({ "session_id": "session-restart", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-restart"
    );
}

#[test]
fn thread_log_history_rebuilds_missing_index_on_first_read() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-rebuild-state-persist",
            "trace-rebuild-state",
            "session.persist_turn",
            json!({
                "session_id": "session-rebuild-state",
                "run_id": "run-rebuild-state",
                "messages": [
                    { "role": "user", "content": "persist me", "messageId": "user-rebuild" },
                    { "role": "assistant", "content": "rebuilt", "messageId": "assistant-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-rebuild-state-history",
        "trace-rebuild-state",
        "session.get_history",
        json!({ "session_id": "session-rebuild-state", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-rebuild"
    );
}

#[test]
fn thread_log_title_is_derived_from_first_user_message_and_survives_state_rebuild() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-title-persist",
            "trace-title-persist",
            "session.persist_turn",
            json!({
                "session_id": "session-title-rebuild",
                "run_id": "run-title-rebuild",
                "messages": [
                    {
                        "role": "user",
                        "content": "  Design backend titles\nwith durable metadata  ",
                        "messageId": "user-title-rebuild"
                    },
                    {
                        "role": "assistant",
                        "content": "done",
                        "messageId": "assistant-title-rebuild"
                    }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }

    let thread_log_path = first_thread_log_file(&fixture.root);
    let thread_log =
        std::fs::read_to_string(&thread_log_path).expect("thread log should be readable");
    assert!(thread_log.contains("\"type\":\"metadata_updated\""));
    assert!(thread_log.contains("\"title\":\"Design backend titles\""));

    let legacy_thread_log = thread_log
        .lines()
        .filter(|line| !line.contains("\"type\":\"metadata_updated\""))
        .map(|line| {
            let mut value: serde_json::Value = serde_json::from_str(line).unwrap();
            value.as_object_mut().unwrap().remove("ordinal");
            serde_json::to_string(&value).unwrap()
        })
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(&thread_log_path, format!("{legacy_thread_log}\n"))
        .expect("legacy thread log fixture should be writable");

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(&state_path).expect("state db should open");
    connection
        .execute(
            "UPDATE threads SET title = 'New session' WHERE session_id = ?1",
            ["session-title-rebuild"],
        )
        .expect("legacy title should be writable");
    drop(connection);
    repair_session_log_index(&fixture.root);

    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
        )
        .unwrap();
        let list = router.dispatch(&WorkerRequest::new(
            "req-title-backfill-list",
            "trace-title-backfill-list",
            "session.list_metadata",
            json!({}),
        ));
        assert_eq!(list.error, None);
        assert_eq!(
            list.result.as_ref().unwrap()[0]["title"],
            "Design backend titles"
        );
    }

    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-title-list",
        "trace-title-list",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["title"],
        "Design backend titles"
    );
}

#[test]
fn session_list_metadata_rebuild_ignores_legacy_thread_item_jsonl() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
                "req-ignore-legacy-items-persist",
                "trace-ignore-legacy-items",
                "session.persist_turn",
                json!({
                    "session_id": "session-ignore-legacy-items",
                    "run_id": "run-ignore-legacy-items",
                    "messages": [
                        { "role": "user", "content": "persist me", "messageId": "user-ignore-legacy-items" },
                        { "role": "assistant", "content": "rebuilt", "messageId": "assistant-ignore-legacy-items" }
                    ],
                    "clear_checkpoint": false
                }),
            ));
        assert_eq!(persist.error, None);
    }
    fixture.write(
            ".tinybot/threads/items/thread-legacy-items.jsonl",
            r#"{"itemId":"legacy-session:1","threadId":"thread-legacy-items","runId":"legacy-history","turnId":"legacy-history","parentItemId":null,"sequence":1,"createdAt":"1783312765469","kind":{"type":"user_message","payload":{"content":"hello","role":"user"}}}
"#,
        );
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-ignore-legacy-items-list",
        "trace-ignore-legacy-items",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    let sessions = list.result.as_ref().unwrap().as_array().unwrap();
    assert!(sessions
        .iter()
        .any(|session| session["session_id"] == "session-ignore-legacy-items"));
}

#[test]
fn session_get_metadata_reads_thread_log_after_state_rebuild() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-metadata-rebuild-persist",
            "trace-metadata-rebuild",
            "session.persist_turn",
            json!({
                "session_id": "session-metadata-rebuild",
                "run_id": "run-metadata-rebuild",
                "messages": [
                    { "role": "user", "content": "metadata", "messageId": "user-metadata-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let metadata = router.dispatch(&WorkerRequest::new(
        "req-metadata-rebuild-get",
        "trace-metadata-rebuild",
        "session.get_metadata",
        json!({ "session_id": "session-metadata-rebuild" }),
    ));

    assert_eq!(metadata.error, None);
    assert_eq!(
        metadata.result.as_ref().unwrap()["session_id"],
        "session-metadata-rebuild"
    );
}

#[test]
fn thread_log_history_rebuilds_corrupt_derived_index_on_first_read() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-corrupt-state-persist",
            "trace-corrupt-state",
            "session.persist_turn",
            json!({
                "session_id": "session-corrupt-state",
                "run_id": "run-corrupt-state",
                "messages": [
                    { "role": "user", "content": "persist me", "messageId": "user-corrupt" },
                    { "role": "assistant", "content": "rebuilt", "messageId": "assistant-corrupt" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
    }
    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::write(&state_path, b"not sqlite").expect("state index should be corruptible");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();
    let history = router.dispatch(&WorkerRequest::new(
        "req-corrupt-state-history",
        "trace-corrupt-state",
        "session.get_history",
        json!({ "session_id": "session-corrupt-state", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][1]["messageId"],
        "assistant-corrupt"
    );
}

#[test]
fn thread_log_history_rejects_state_index_path_escape() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-path-escape-persist",
        "trace-path-escape",
        "session.persist_turn",
        json!({
            "session_id": "session-path-escape",
            "run_id": "run-path-escape",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-path-escape" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let canonical_path = first_thread_log_file(&fixture.root);
    let escaped_path = fixture.root.join("escaped.jsonl");
    let connection = rusqlite::Connection::open(&state_path).unwrap();
    connection
        .execute(
            "UPDATE threads SET thread_path = ?1 WHERE session_id = ?2",
            rusqlite::params![escaped_path.display().to_string(), "session-path-escape"],
        )
        .unwrap();
    drop(connection);

    let history = router.dispatch(&WorkerRequest::new(
        "req-path-escape-history",
        "trace-path-escape",
        "session.get_history",
        json!({ "session_id": "session-path-escape", "limit": 80 }),
    ));

    assert_eq!(history.error, None);
    assert_eq!(
        history.result.as_ref().unwrap()["messages"][0]["content"],
        "hello"
    );
    let connection = rusqlite::Connection::open(&state_path).unwrap();
    let repaired_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-path-escape"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    assert_eq!(repaired_path, canonical_path.display().to_string());
}

#[test]
fn session_list_metadata_does_not_merge_in_memory_legacy_sessions() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "legacy-session".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-mixed-list-persist",
        "trace-mixed-list",
        "session.persist_turn",
        json!({
            "session_id": "thread-log-session",
            "run_id": "run-thread-log-session",
            "messages": [
                { "role": "user", "content": "hello", "messageId": "user-mixed" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-mixed-list",
        "trace-mixed-list",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    let session_ids = list
        .result
        .as_ref()
        .unwrap()
        .as_array()
        .unwrap()
        .iter()
        .map(|session| session["session_id"].as_str().unwrap().to_string())
        .collect::<Vec<_>>();
    assert_eq!(session_ids, vec!["thread-log-session".to_string()]);
}

#[test]
fn session_list_metadata_sorts_unix_ms_and_iso_timestamps_by_time() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "legacy-old-session".to_string();
    legacy_session.updated_at = "unix-ms:1".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-sort-mixed-timestamps-persist",
        "trace-sort-mixed-timestamps",
        "session.persist_turn",
        json!({
            "session_id": "thread-log-new-session",
            "run_id": "run-thread-log-new-session",
            "messages": [
                { "role": "user", "content": "newer", "messageId": "user-sort-mixed" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);

    let list = router.dispatch(&WorkerRequest::new(
        "req-sort-mixed-timestamps-list",
        "trace-sort-mixed-timestamps",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["session_id"],
        "thread-log-new-session"
    );
}

#[test]
fn session_log_index_prunes_missing_canonical_rollout_automatically() {
    let fixture = WorkspaceFixture::new();
    {
        let router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        router
            .thread_log
            .persist_session_turn(
                "session-prune-missing-log",
                "run-prune-missing-log",
                vec![json!({
                    "role": "user",
                    "content": "stale",
                    "messageId": "user-prune-missing"
                })],
                None,
            )
            .unwrap();
    }
    let thread_log_path = first_thread_log_file(&fixture.root);
    std::fs::remove_file(thread_log_path).expect("thread log should be removable");

    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionMetadataRead,
            WorkerCapability::SessionWrite,
        ]),
    )
    .unwrap();
    let list = router.dispatch(&WorkerRequest::new(
        "req-prune-missing-log-list",
        "trace-prune-missing-log",
        "session.list_metadata",
        json!({}),
    ));

    assert_eq!(list.error, None);
    assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());

    let check = router.dispatch(&WorkerRequest::new(
        "req-missing-log-check",
        "trace-missing-log-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(check.error, None);
    assert_eq!(check.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_context_checkpoint_commit_is_durable_and_idempotent() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let checkpoint = json!({
        "schemaVersion": 1,
        "contextId": "run-commit-context:context:1",
        "sourceVersion": "sha256:fixture",
        "sourceContextId": null,
        "windowNumber": 1,
        "firstWindowId": "session-commit-context:context-window:0",
        "previousWindowId": "session-commit-context:context-window:0",
        "windowId": "run-commit-context:context:1",
        "checkpointStage": "installed",
        "replacementHistory": [
            { "role": "system", "content": "summary" },
            { "role": "user", "content": "current question" }
        ]
    });
    let request = || {
        WorkerRequest::new(
            "req-commit-context",
            "trace-commit-context",
            "session.commit_context_checkpoint",
            json!({
                "session_id": "session-commit-context",
                "run_id": "run-commit-context",
                "checkpoint": checkpoint
            }),
        )
    };

    let first = router.dispatch(&request());
    assert_eq!(first.error, None);
    assert_eq!(first.result.as_ref().unwrap()["committed"], true);
    assert_eq!(first.result.as_ref().unwrap()["duplicate"], false);
    assert_eq!(first.result.as_ref().unwrap()["indexSynchronized"], true);
    assert_eq!(first.result.as_ref().unwrap()["indexRecovered"], false);

    let duplicate = router.dispatch(&request());
    assert_eq!(duplicate.error, None);
    assert_eq!(duplicate.result.as_ref().unwrap()["committed"], false);
    assert_eq!(duplicate.result.as_ref().unwrap()["duplicate"], true);

    let context = router.dispatch(&WorkerRequest::new(
        "req-read-committed-context",
        "trace-read-committed-context",
        "session.get_agent_context",
        json!({ "session_id": "session-commit-context", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"],
        checkpoint["replacementHistory"]
    );
    assert_eq!(
        context.result.as_ref().unwrap()["contextCheckpoint"]["contextId"],
        "run-commit-context:context:1"
    );

    let stale = router.dispatch(&WorkerRequest::new(
        "req-stale-context",
        "trace-stale-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-stale-context",
            "checkpoint": {
                "contextId": "run-stale-context:context:1",
                "sourceContextId": null,
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "stale summary" }]
            }
        }),
    ));
    assert!(stale.error.as_ref().is_some_and(|error| error
        .message
        .contains("stale context compaction checkpoint")));

    let skipped_window = router.dispatch(&WorkerRequest::new(
        "req-skipped-context-window",
        "trace-skipped-context-window",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-skipped-context-window",
            "checkpoint": {
                "contextId": "run-skipped-context-window:context:1",
                "sourceContextId": "run-commit-context:context:1",
                "windowNumber": 9,
                "firstWindowId": "session-commit-context:context-window:0",
                "previousWindowId": "run-commit-context:context:1",
                "windowId": "run-skipped-context-window:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "skipped window" }]
            }
        }),
    ));
    assert!(skipped_window.error.as_ref().is_some_and(|error| {
        error.message.contains("invalid windowNumber")
            && error.details["expected"] == 2
            && error.details["actual"] == 9
    }));

    let next = router.dispatch(&WorkerRequest::new(
        "req-next-context",
        "trace-next-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-next-context",
            "checkpoint": {
                "contextId": "run-next-context:context:1",
                "sourceContextId": "run-commit-context:context:1",
                "windowNumber": 2,
                "firstWindowId": "session-commit-context:context-window:0",
                "previousWindowId": "run-commit-context:context:1",
                "windowId": "run-next-context:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "next summary" }]
            }
        }),
    ));
    assert_eq!(next.error, None);
    assert_eq!(next.result.as_ref().unwrap()["committed"], true);

    let historical_retry = router.dispatch(&request());
    assert!(
        historical_retry.error.as_ref().is_some_and(|error| {
            error
                .message
                .contains("checkpoint identity is historical and no longer current")
        }),
        "{:?}",
        historical_retry.error
    );

    let mut stale_finalized_checkpoint = checkpoint.clone();
    stale_finalized_checkpoint["checkpointStage"] = json!("finalized");
    let stale_finalization = router.dispatch(&WorkerRequest::new(
        "req-stale-context-finalization",
        "trace-stale-context-finalization",
        "session.persist_turn",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-stale-context-finalization",
            "messages": [],
            "clear_checkpoint": false,
            "context_metadata": {
                "contextCheckpoint": stale_finalized_checkpoint
            }
        }),
    ));
    assert!(stale_finalization.error.as_ref().is_some_and(|error| {
        error.message.contains("invalid contextId")
            && error.details["expected"] == "run-next-context:context:1"
            && error.details["actual"] == "run-commit-context:context:1"
    }));

    let conflict = router.dispatch(&WorkerRequest::new(
        "req-conflicting-context",
        "trace-conflicting-context",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-commit-context",
            "run_id": "run-commit-context",
            "checkpoint": {
                "contextId": "run-commit-context:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "different" }]
            }
        }),
    ));
    assert!(conflict.error.is_some());
}

#[test]
fn session_clear_resets_latest_checkpoint_lineage_without_reviving_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let commit = |context_id: &str, summary: &str| {
        WorkerRequest::new(
            format!("req-{context_id}"),
            "trace-clear-checkpoint",
            "session.commit_context_checkpoint",
            json!({
                "session_id": "session-clear-checkpoint",
                "run_id": context_id,
                "checkpoint": {
                    "contextId": context_id,
                    "sourceContextId": null,
                    "windowNumber": 1,
                    "firstWindowId": "session-clear-checkpoint:context-window:0",
                    "previousWindowId": "session-clear-checkpoint:context-window:0",
                    "windowId": context_id,
                    "checkpointStage": "installed",
                    "replacementHistory": [{ "role": "system", "content": summary }]
                }
            }),
        )
    };

    let first = router.dispatch(&commit("context-before-clear", "old summary"));
    assert_eq!(first.error, None);
    let clear = router.dispatch(&WorkerRequest::new(
        "req-clear-checkpoint",
        "trace-clear-checkpoint",
        "session.clear",
        json!({ "session_id": "session-clear-checkpoint" }),
    ));
    assert_eq!(clear.error, None);

    let fresh = router.dispatch(&commit("context-after-clear", "fresh summary"));
    assert_eq!(fresh.error, None);
    assert_eq!(fresh.result.as_ref().unwrap()["committed"], true);

    let historical = router.dispatch(&commit("context-before-clear", "old summary"));
    assert!(historical.error.as_ref().is_some_and(|error| {
        error
            .message
            .contains("checkpoint identity is historical and no longer current")
    }));
    let context = router.dispatch(&WorkerRequest::new(
        "req-read-after-clear-checkpoint",
        "trace-clear-checkpoint",
        "session.get_agent_context",
        json!({ "session_id": "session-clear-checkpoint", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "fresh summary"
    );
}

#[test]
fn session_checkpoint_ordinal_index_self_heals_from_canonical_rollout() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let committed = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position",
        "trace-checkpoint-position",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-checkpoint-position",
            "run_id": "run-checkpoint-position",
            "checkpoint": {
                "contextId": "context-position",
                "sourceContextId": null,
                "windowNumber": 1,
                "firstWindowId": "session-checkpoint-position:context-window:0",
                "previousWindowId": "session-checkpoint-position:context-window:0",
                "windowId": "context-position",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "indexed summary" }]
            }
        }),
    ));
    assert_eq!(committed.error, None);

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    connection
        .execute("UPDATE latest_context_checkpoints SET ordinal = 999", [])
        .unwrap();
    drop(connection);

    let context = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position-read",
        "trace-checkpoint-position",
        "session.get_agent_context",
        json!({ "session_id": "session-checkpoint-position", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "indexed summary"
    );
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-checkpoint-position-check",
        "trace-checkpoint-position",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_agent_context_self_heals_after_canonical_rollout_advances() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-head-mismatch",
            "run-head-mismatch",
            vec![json!({ "role": "user", "content": "indexed message" })],
            None,
        )
        .unwrap();

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    let thread_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-head-mismatch"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    drop(connection);
    let next_ordinal = std::fs::read_to_string(&thread_path)
        .unwrap()
        .lines()
        .count() as u64;
    let external_line = crate::threads::rollout::store::ThreadLogLine {
        timestamp: "2026-07-17T10:00:00.000Z".to_string(),
        ordinal: Some(next_ordinal),
        item: crate::threads::rollout::store::ThreadLogItem::ResponseItem(
            crate::threads::rollout::format::ResponseItem::from_value(
                json!({ "role": "assistant", "content": "external append" }),
            )
            .unwrap(),
        ),
    };
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&thread_path)
        .unwrap();
    writeln!(file, "{}", serde_json::to_string(&external_line).unwrap()).unwrap();
    drop(file);

    let context = router.dispatch(&WorkerRequest::new(
        "req-head-mismatch-read",
        "trace-head-mismatch",
        "session.get_agent_context",
        json!({ "session_id": "session-head-mismatch", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][1]["content"],
        "external append"
    );
}

#[test]
fn session_agent_context_fast_path_does_not_scan_unrelated_journals() {
    let fixture = WorkspaceFixture::new();
    let router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    for (session_id, run_id, content) in [
        ("session-fast-target", "run-fast-target", "target message"),
        ("session-fast-other", "run-fast-other", "other message"),
    ] {
        router
            .thread_log
            .persist_session_turn(
                session_id,
                run_id,
                vec![json!({ "role": "user", "content": content })],
                None,
            )
            .unwrap();
    }

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    let connection = rusqlite::Connection::open(state_path).unwrap();
    let unrelated_path = connection
        .query_row(
            "SELECT thread_path FROM threads WHERE session_id = ?1",
            ["session-fast-other"],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    drop(connection);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(unrelated_path)
        .unwrap();
    writeln!(file, "not-json").unwrap();
    drop(file);

    let context = router
        .thread_log
        .get_agent_context("session-fast-target", 50)
        .unwrap()
        .unwrap();
    assert_eq!(context.messages[0]["content"], "target message");
}

#[test]
fn session_context_checkpoint_commit_recovers_transient_index_failure() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-index-retry",
            "run-before-index-retry",
            vec![json!({ "role": "user", "content": "old context" })],
            None,
        )
        .unwrap();
    router.thread_log.fail_next_state_index_upserts(1);

    let committed = router.dispatch(&WorkerRequest::new(
        "req-index-retry",
        "trace-index-retry",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-index-retry",
            "run_id": "run-index-retry",
            "checkpoint": {
                "contextId": "run-index-retry:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "recovered summary" }]
            }
        }),
    ));

    assert_eq!(committed.error, None);
    assert_eq!(committed.result.as_ref().unwrap()["committed"], true);
    assert_eq!(
        committed.result.as_ref().unwrap()["indexSynchronized"],
        true
    );
    assert_eq!(committed.result.as_ref().unwrap()["indexRecovered"], true);
    assert!(committed.result.as_ref().unwrap()["diagnostics"]
        .as_array()
        .is_some_and(|diagnostics| !diagnostics.is_empty()));
    let consistency = router.dispatch(&WorkerRequest::new(
        "req-index-retry-check",
        "trace-index-retry-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "clean");
}

#[test]
fn session_context_checkpoint_commit_reports_degraded_index_without_losing_journal() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-index-degraded",
            "run-before-index-degraded",
            vec![json!({ "role": "user", "content": "old context" })],
            None,
        )
        .unwrap();
    router.thread_log.fail_next_state_index_upserts(2);

    let committed = router.dispatch(&WorkerRequest::new(
        "req-index-degraded",
        "trace-index-degraded",
        "session.commit_context_checkpoint",
        json!({
            "session_id": "session-index-degraded",
            "run_id": "run-index-degraded",
            "checkpoint": {
                "contextId": "run-index-degraded:context:1",
                "checkpointStage": "installed",
                "replacementHistory": [{ "role": "system", "content": "durable summary" }]
            }
        }),
    ));

    assert_eq!(committed.error, None);
    assert_eq!(committed.result.as_ref().unwrap()["committed"], true);
    assert_eq!(
        committed.result.as_ref().unwrap()["indexSynchronized"],
        false
    );
    assert_eq!(committed.result.as_ref().unwrap()["indexRecovered"], false);
    assert!(committed.result.as_ref().unwrap()["diagnostics"][0]
        .as_str()
        .is_some_and(|message| message.contains("checkpoint is durable")));

    let consistency = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-check",
        "trace-index-degraded-check",
        "session.persistence.check",
        json!({}),
    ));
    assert_eq!(consistency.error, None);
    assert_eq!(consistency.result.as_ref().unwrap()["status"], "diverged");

    let repair = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-repair",
        "trace-index-degraded-repair",
        "session.persistence.repair",
        json!({ "mode": "rebuild_index" }),
    ));
    assert_eq!(repair.error, None);
    assert_eq!(repair.result.as_ref().unwrap()["after"]["status"], "clean");
    let context = router.dispatch(&WorkerRequest::new(
        "req-index-degraded-context",
        "trace-index-degraded-context",
        "session.get_agent_context",
        json!({ "session_id": "session-index-degraded", "limit": 50 }),
    ));
    assert_eq!(context.error, None);
    assert_eq!(
        context.result.as_ref().unwrap()["messages"][0]["content"],
        "durable summary"
    );
}

#[test]
fn session_delete_removes_thread_log_only_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log-persist",
        "trace-delete-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-delete-thread-log",
            "run_id": "run-delete-thread-log",
            "messages": [
                { "role": "user", "content": "delete me", "messageId": "user-delete-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let delete = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log",
        "trace-delete-thread-log",
        "session.delete",
        json!({ "session_id": "session-delete-thread-log" }),
    ));
    assert_eq!(delete.error, None);
    assert_eq!(delete.result.as_ref().unwrap()["deleted"], true);

    let list = router.dispatch(&WorkerRequest::new(
        "req-delete-thread-log-list",
        "trace-delete-thread-log",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert!(list.result.as_ref().unwrap().as_array().unwrap().is_empty());
}

#[test]
fn session_clear_clears_thread_log_history() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log-persist",
        "trace-clear-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-clear-thread-log",
            "run_id": "run-clear-thread-log",
            "messages": [
                { "role": "user", "content": "clear me", "messageId": "user-clear-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let clear = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log",
        "trace-clear-thread-log",
        "session.clear",
        json!({ "session_id": "session-clear-thread-log" }),
    ));
    assert_eq!(clear.error, None);
    assert_eq!(clear.result.as_ref().unwrap()["messages_before"], 1);

    let history = router.dispatch(&WorkerRequest::new(
        "req-clear-thread-log-history",
        "trace-clear-thread-log",
        "session.get_history",
        json!({ "session_id": "session-clear-thread-log", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert!(history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn session_clear_rebuilds_thread_log_projection_without_stale_token_usage() {
    let fixture = WorkspaceFixture::new();
    {
        let mut router = WorkerRpcRouter::new_persistent_sessions(
            fixture.root.clone(),
            json!({}),
            vec![],
            50,
            CapabilityPolicy::new([
                WorkerCapability::SessionWrite,
                WorkerCapability::SessionMetadataRead,
            ]),
        )
        .unwrap();
        let persist = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-persist",
            "trace-clear-rebuild",
            "session.persist_turn",
            json!({
                "session_id": "session-clear-rebuild",
                "run_id": "run-clear-rebuild",
                "messages": [
                    { "role": "user", "content": "clear me", "messageId": "user-clear-rebuild" },
                    { "role": "assistant", "content": "ok", "messageId": "assistant-clear-rebuild" }
                ],
                "clear_checkpoint": false
            }),
        ));
        assert_eq!(persist.error, None);
        router
            .thread_log
            .append_token_count(
                "session-clear-rebuild",
                crate::threads::rollout::store::TokenUsageInfo {
                    total_token_usage: crate::threads::rollout::store::TokenUsage {
                        input_tokens: 1010,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 1172,
                    },
                    last_token_usage: crate::threads::rollout::store::TokenUsage {
                        input_tokens: 10,
                        cached_input_tokens: 0,
                        output_tokens: 162,
                        reasoning_output_tokens: 0,
                        total_tokens: 172,
                    },
                    model_context_window: Some(128000),
                },
            )
            .unwrap();
        let clear = router.dispatch(&WorkerRequest::new(
            "req-clear-rebuild-clear",
            "trace-clear-rebuild",
            "session.clear",
            json!({ "session_id": "session-clear-rebuild" }),
        ));
        assert_eq!(clear.error, None);
    }

    let state_path = fixture
        .root
        .join(".tinybot")
        .join("state")
        .join("state.sqlite");
    std::fs::remove_file(&state_path).expect("state index should be removable");
    prepare_session_log_index_for_startup(&fixture.root);
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([WorkerCapability::SessionMetadataRead]),
    )
    .unwrap();

    let list = router.dispatch(&WorkerRequest::new(
        "req-clear-rebuild-list",
        "trace-clear-rebuild",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(list.result.as_ref().unwrap()[0]["extra"]["tokensUsed"], 0);

    let history = router.dispatch(&WorkerRequest::new(
        "req-clear-rebuild-history",
        "trace-clear-rebuild",
        "session.get_history",
        json!({ "session_id": "session-clear-rebuild", "limit": 80 }),
    ));
    assert_eq!(history.error, None);
    assert!(history.result.as_ref().unwrap()["messages"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn session_patch_metadata_updates_thread_log_list_projection() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    let persist = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-persist",
        "trace-patch-thread-log",
        "session.persist_turn",
        json!({
            "session_id": "session-patch-thread-log",
            "run_id": "run-patch-thread-log",
            "messages": [
                { "role": "user", "content": "rename me", "messageId": "user-patch-thread-log" }
            ],
            "clear_checkpoint": false
        }),
    ));
    assert_eq!(persist.error, None);
    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log",
        "trace-patch-thread-log",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-thread-log",
            "metadata": { "title": "Thread log title" }
        }),
    ));
    assert_eq!(patch.error, None);
    assert_eq!(patch.result.as_ref().unwrap()["title"], "Thread log title");

    let list = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-list",
        "trace-patch-thread-log",
        "session.list_metadata",
        json!({}),
    ));
    assert_eq!(list.error, None);
    assert_eq!(
        list.result.as_ref().unwrap()[0]["title"],
        "Thread log title"
    );
}

#[test]
fn session_patch_metadata_allows_thread_log_only_session() {
    let fixture = WorkspaceFixture::new();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-patch-thread-log-only",
            "run-patch-thread-log-only",
            vec![json!({
                "role": "user",
                "content": "rename me",
                "messageId": "user-patch-thread-log-only"
            })],
            None,
        )
        .unwrap();

    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-thread-log-only",
        "trace-patch-thread-log-only",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-thread-log-only",
            "metadata": { "title": "Thread log only title" }
        }),
    ));

    assert_eq!(patch.error, None);
    assert_eq!(
        patch.result.as_ref().unwrap()["title"],
        "Thread log only title"
    );
}

#[test]
fn session_patch_metadata_prefers_thread_log_over_legacy_persistence() {
    let fixture = WorkspaceFixture::new();
    let mut legacy_session = session_fixture();
    legacy_session.session_id = "session-patch-legacy-error".to_string();
    let mut router = WorkerRpcRouter::new_persistent_sessions(
        fixture.root.clone(),
        json!({}),
        vec![legacy_session],
        50,
        CapabilityPolicy::new([
            WorkerCapability::SessionWrite,
            WorkerCapability::SessionMetadataRead,
        ]),
    )
    .unwrap();
    router
        .thread_log
        .persist_session_turn(
            "session-patch-legacy-error",
            "run-patch-legacy-error",
            vec![json!({
                "role": "user",
                "content": "rename me",
                "messageId": "user-patch-legacy-error"
            })],
            None,
        )
        .unwrap();
    let patch = router.dispatch(&WorkerRequest::new(
        "req-patch-legacy-error",
        "trace-patch-legacy-error",
        "session.patch_metadata",
        json!({
            "session_id": "session-patch-legacy-error",
            "metadata": { "title": "Should not hide legacy failure" }
        }),
    ));

    assert_eq!(
        patch.result.as_ref().unwrap()["title"],
        "Should not hide legacy failure"
    );
    assert!(patch.error.is_none());
}
