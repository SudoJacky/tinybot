use super::*;
use serde_json::json;

#[test]
fn runtime_phase_serializes_as_snake_case() {
    assert_eq!(
        serde_json::to_value(AgentRuntimePhase::HydratingHistory).unwrap(),
        json!("hydrating_history")
    );
    assert_eq!(
        serde_json::to_value(AgentRuntimePhase::AwaitingApproval).unwrap(),
        json!("awaiting_approval")
    );
    assert_eq!(
        serde_json::to_value(AgentRuntimePhase::Cancelled).unwrap(),
        json!("cancelled")
    );
}

#[test]
fn continuation_input_serializes_stable_shape() {
    let approval = AgentContinuationInput::Approval {
        approval_id: "approval-1".to_string(),
        decision: AgentApprovalDecision::Denied,
        scope: AgentApprovalScope::Session,
        guidance: Some("Use a read-only command instead.".to_string()),
    };

    assert_eq!(
        serde_json::to_value(approval).unwrap(),
        json!({
            "kind": "approval",
            "approvalId": "approval-1",
            "decision": "denied",
            "scope": "session",
            "guidance": "Use a read-only command instead."
        })
    );

    let form = AgentContinuationInput::Form {
        form_id: "form-1".to_string(),
        action: AgentFormAction::Submit,
        values: Some(json!({ "path": "README.md" })),
    };

    assert_eq!(
        serde_json::to_value(form).unwrap(),
        json!({
            "kind": "form",
            "formId": "form-1",
            "action": "submit",
            "values": { "path": "README.md" }
        })
    );
}

#[test]
fn turn_item_serializes_stable_shape() {
    let item = AgentTurnItem {
        schema_version: AGENT_TURN_ITEM_SCHEMA_VERSION.to_string(),
        item_id: "item-1".to_string(),
        session_id: "session-1".to_string(),
        thread_id: None,
        turn_id: "turn-1".to_string(),
        parent_item_id: None,
        sequence: 7,
        revision: 1,
        kind: AgentTurnItemKind::ToolCall,
        status: AgentTurnItemStatus::Running,
        created_at: "2026-07-03T00:00:00Z".to_string(),
        updated_at: None,
        title: Some("Reading file".to_string()),
        summary: None,
        data: AgentTurnItemData::ToolCall {
            tool_call_id: "tool-1".to_string(),
            name: "read_file".to_string(),
            status: "running".to_string(),
            args: Value::Null,
            result: Value::Null,
            detail_id: None,
            timing: Value::Null,
        },
        payload: json!({ "toolName": "read_file" }),
    };

    assert_eq!(
        serde_json::to_value(item).unwrap(),
        json!({
            "schemaVersion": "tinybot.turn_item.v2",
            "itemId": "item-1",
            "sessionId": "session-1",
            "turnId": "turn-1",
            "sequence": 7,
            "revision": 1,
            "kind": "tool_call",
            "status": "running",
            "createdAt": "2026-07-03T00:00:00Z",
            "title": "Reading file",
            "data": {
                "type": "tool_call",
                "toolCallId": "tool-1",
                "name": "read_file",
                "status": "running",
                "args": null,
                "result": null,
                "detailId": null,
                "timing": null
            }
        })
    );
}

#[test]
fn legacy_native_event_maps_to_runtime_envelope() {
    let envelope =
        AgentRuntimeEventEnvelope::from_legacy_native_event(LegacyNativeAgentEventEnvelopeInput {
            session_id: "session-1".to_string(),
            thread_id: None,
            turn_id: "turn-1".to_string(),
            parent_turn_id: None,
            item_id: Some("item-1".to_string()),
            event_name: "agent.tool.start".to_string(),
            sequence: 7,
            timestamp: "2026-07-03T00:00:07Z".to_string(),
            payload: json!({ "toolName": "read_file" }),
        });

    assert_eq!(
        serde_json::to_value(envelope).unwrap(),
        json!({
            "schemaVersion": "tinybot.agent_event.v1",
            "eventId": "turn-1:agent-tool-start:0000000000000007",
            "sequence": 7,
            "sessionId": "session-1",
            "turnId": "turn-1",
            "itemId": "item-1",
            "eventName": "agent.tool.start",
            "phase": "tool_running",
            "timestamp": "2026-07-03T00:00:07Z",
            "source": "rust_backend",
            "visibility": "user",
            "payload": { "toolName": "read_file" }
        })
    );
}

#[test]
fn legacy_native_event_name_maps_to_turn_item_kind() {
    assert_eq!(
        AgentTurnItemKind::for_legacy_event("agent.tool.result"),
        Some(AgentTurnItemKind::ToolCall)
    );
    assert_eq!(
        AgentTurnItemKind::for_legacy_event("agent.awaiting_approval"),
        Some(AgentTurnItemKind::Approval)
    );
    assert_eq!(
        AgentTurnItemKind::for_legacy_event("agent.delegate.completed"),
        Some(AgentTurnItemKind::SubagentLifecycle)
    );
    assert_eq!(
        AgentRuntimePhase::for_legacy_event("agent.delegate.linked"),
        AgentRuntimePhase::AwaitingSubagent
    );
}

#[test]
fn subagent_lifecycle_retains_parent_and_assigned_work_correlation() {
    let items = project_turn_items_from_trace_events(&[runtime_event(
        "turn-parent",
        "agent.delegate.linked",
        AgentRuntimePhase::AwaitingSubagent,
        Some("subagent-1"),
        1,
        json!({
            "delegateId": "agent-child",
            "childTurnId": "turn-child",
            "childThreadId": "thread-child",
            "parentAgentId": "agent-main",
            "parentTurnId": "turn-parent",
            "name": "Reviewer",
            "task": "Review the implementation",
            "status": "running",
            "traceRef": "trace-child"
        }),
    )]);

    let data = serde_json::to_value(&items[0].data).unwrap();
    assert_eq!(data["agentId"], "agent-child");
    assert_eq!(data["childTurnId"], "turn-child");
    assert_eq!(data["childThreadId"], "thread-child");
    assert_eq!(data["parentAgentId"], "agent-main");
    assert_eq!(data["parentTurnId"], "turn-parent");
    assert_eq!(data["name"], "Reviewer");
    assert_eq!(data["task"], "Review the implementation");
    assert_eq!(data["traceRef"], "trace-child");
}

#[test]
fn event_appender_assigns_monotonic_sequences_and_stable_ids() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");

    let first = appender.append(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.turn.started".to_string(),
        phase: AgentRuntimePhase::Planning,
        timestamp: "2026-07-03T00:00:00Z".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        payload: json!({}),
    });
    let second = appender.append(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: Some("item-1".to_string()),
        event_name: "agent.delta".to_string(),
        phase: AgentRuntimePhase::StreamingModel,
        timestamp: "2026-07-03T00:00:01Z".to_string(),
        source: AgentRuntimeEventSource::Provider,
        visibility: AgentRuntimeEventVisibility::User,
        payload: json!({ "delta": "hello" }),
    });

    assert_eq!(first.sequence, 1);
    assert_eq!(first.event_id, "turn-1:agent-turn-started:0000000000000001");
    assert_eq!(second.sequence, 2);
    assert_eq!(second.event_id, "turn-1:agent-delta:0000000000000002");
    assert_eq!(appender.next_sequence(), 3);
}

#[test]
fn event_appender_resumes_after_existing_events() {
    let existing =
        AgentRuntimeEventEnvelope::from_legacy_native_event(LegacyNativeAgentEventEnvelopeInput {
            session_id: "session-1".to_string(),
            thread_id: None,
            turn_id: "turn-1".to_string(),
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.delta".to_string(),
            sequence: 12,
            timestamp: "2026-07-03T00:00:12Z".to_string(),
            payload: json!({ "delta": "existing" }),
        });
    let mut appender =
        AgentRuntimeEventAppender::from_existing_events("session-1", "turn-1", &[existing]);

    let next = appender.append_legacy_native_event(
        "agent.done",
        None,
        "2026-07-03T00:00:13Z",
        json!({ "finalContent": "done" }),
    );

    assert_eq!(next.sequence, 13);
    assert_eq!(next.event_id, "turn-1:agent-done:0000000000000013");
    assert_eq!(next.phase, AgentRuntimePhase::Completed);
    assert_eq!(appender.next_sequence(), 14);
}

#[test]
fn turn_emitter_buffers_events_and_takes_them_in_sequence_order() {
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

    let first = emitter.phase_changed(
        "2026-07-03T00:00:00Z",
        AgentRuntimePhase::Planning,
        AgentRuntimePhase::CallingModel,
    );
    let second = emitter.message_completed(
        "2026-07-03T00:00:01Z",
        Some("assistant-1".to_string()),
        "Hello",
    );

    assert_eq!(first.sequence, 1);
    assert_eq!(second.sequence, 2);
    assert_eq!(
        second.event_id,
        "turn-1:agent-message-completed:0000000000000002"
    );
    assert_eq!(emitter.events().len(), 2);

    let events = emitter.take_events();
    assert_eq!(
        events
            .iter()
            .map(|event| event.event_name.as_str())
            .collect::<Vec<_>>(),
        vec!["agent.phase.changed", "agent.message.completed"]
    );
    assert!(emitter.events().is_empty());
    assert_eq!(emitter.next_sequence(), 3);
}

#[test]
fn turn_emitter_status_event_is_user_visible_without_turn_item() {
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

    let event = emitter.status(
        "2026-07-03T00:00:01Z",
        AgentRuntimePhase::ToolRunning,
        "Running tool",
        Some("workspace.read_file".to_string()),
        Some(2),
        false,
    );

    assert_eq!(event.event_name, "agent.status");
    assert_eq!(event.phase, AgentRuntimePhase::ToolRunning);
    assert_eq!(event.visibility, AgentRuntimeEventVisibility::User);
    assert_eq!(event.payload["phase"], "tool_running");
    assert_eq!(event.payload["label"], "Running tool");
    assert_eq!(event.payload["detail"], "workspace.read_file");
    assert_eq!(event.payload["iteration"], 2);
    assert_eq!(event.payload["isBlocking"], false);
    assert!(project_turn_items_from_trace_events(&[event]).is_empty());
}

#[test]
fn turn_emitter_helpers_emit_canonical_payloads() {
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

    emitter.user_turn_started(
        "2026-07-03T00:00:00Z",
        Some("user-1".to_string()),
        None,
        "Start",
        Vec::new(),
    );
    emitter.tool_start(
        "2026-07-03T00:00:01Z",
        "call-1",
        "workspace.read_file",
        json!({ "path": "README.md" }),
    );
    emitter.tool_result(
        "2026-07-03T00:00:02Z",
        "call-1",
        "workspace.read_file",
        json!({ "status": "ok", "summary": "read README" }),
    );
    emitter.awaiting_approval(
        "2026-07-03T00:00:03Z",
        "approval-1",
        json!({ "summary": "Allow write?" }),
    );
    emitter.approval_decision(
        "2026-07-03T00:00:04Z",
        "approval-1",
        AgentApprovalDecision::Denied,
        AgentApprovalScope::Once,
        Some("Do not write.".to_string()),
    );

    let events = emitter.take_events();
    assert_eq!(events[0].event_name, "agent.turn.started");
    assert_eq!(events[0].payload["userMessage"]["content"], "Start");
    assert_eq!(events[1].item_id.as_deref(), Some("call-1"));
    assert_eq!(events[1].payload["args"]["path"], "README.md");
    assert_eq!(events[2].payload["envelope"]["summary"], "read README");
    assert_eq!(events[3].phase, AgentRuntimePhase::AwaitingApproval);
    assert_eq!(events[4].payload["decision"], "denied");
    assert_eq!(events[4].payload["guidance"], "Do not write.");
}

#[test]
fn runtime_events_project_to_legacy_native_event_shape() {
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    emitter.message_completed(
        "2026-07-03T00:00:01Z",
        Some("assistant-1".to_string()),
        "Hello",
    );
    emitter.done(
        "2026-07-03T00:00:02Z",
        "final_response",
        json!({ "iterationCount": 1 }),
    );

    let legacy = project_legacy_native_agent_events(emitter.events());

    assert_eq!(legacy.len(), 2);
    assert_eq!(
        serde_json::to_value(&legacy[0]).unwrap(),
        json!({
            "eventName": "agent.message.completed",
            "payload": {
                "messageId": "assistant-1",
                "content": "Hello"
            }
        })
    );
    assert_eq!(legacy[1].event_name, "agent.done");
    assert_eq!(legacy[1].payload["stopReason"], "final_response");
}

#[test]
fn trace_projection_combines_assistant_deltas_into_one_item() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append_legacy_native_event(
            "agent.delta",
            None,
            "2026-07-03T00:00:01Z",
            json!({ "delta": "Hel" }),
        ),
        appender.append_legacy_native_event(
            "agent.delta",
            None,
            "2026-07-03T00:00:02Z",
            json!({ "delta": "lo" }),
        ),
        appender.append_legacy_native_event(
            "agent.done",
            None,
            "2026-07-03T00:00:03Z",
            json!({ "finalContent": "Hello" }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "turn-1:assistant:legacy");
    assert_eq!(items[0].kind, AgentTurnItemKind::AssistantMessage);
    assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
    assert_eq!(items[0].payload, json!({ "content": "Hello" }));
    assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
    assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:03Z"));
}

#[test]
fn trace_projection_restores_user_prompt_from_turn_started() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![appender.append(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.turn.started".to_string(),
        phase: AgentRuntimePhase::Planning,
        timestamp: "2026-07-03T00:00:00Z".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        payload: json!({
            "userMessageId": "user-1",
            "userMessage": { "id": "user-1", "content": "Approve the write" }
        }),
    })];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "turn-1:user");
    assert_eq!(items[0].kind, AgentTurnItemKind::UserMessage);
    assert_eq!(
        items[0].payload,
        json!({
            "messageId": "user-1",
            "content": "Approve the write"
        })
    );
}

#[test]
fn trace_projection_ignores_waiting_done_without_final_content() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append_legacy_native_event(
            "agent.awaiting_approval",
            Some("approval-1".to_string()),
            "2026-07-03T00:00:01Z",
            json!({ "approvalId": "approval-1", "reason": "Needs write approval" }),
        ),
        appender.append_legacy_native_event(
            "agent.done",
            None,
            "2026-07-03T00:00:02Z",
            json!({ "stopReason": "awaiting_approval" }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, AgentTurnItemKind::Approval);
    assert_eq!(items[0].status, AgentTurnItemStatus::Waiting);
}

#[test]
fn trace_projection_restores_message_completed_without_legacy_done_content() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.message.completed".to_string(),
            phase: AgentRuntimePhase::Completed,
            timestamp: "2026-07-03T00:00:01Z".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::User,
            payload: json!({
                "messageId": "assistant-1",
                "content": "Hello from canonical completion"
            }),
        }),
        appender.append(AgentRuntimeEventAppendInput {
            parent_turn_id: None,
            item_id: None,
            event_name: "agent.done".to_string(),
            phase: AgentRuntimePhase::Completed,
            timestamp: "2026-07-03T00:00:02Z".to_string(),
            source: AgentRuntimeEventSource::RustBackend,
            visibility: AgentRuntimeEventVisibility::Debug,
            payload: json!({ "stopReason": "final_response" }),
        }),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "turn-1:assistant:legacy");
    assert_eq!(items[0].kind, AgentTurnItemKind::AssistantMessage);
    assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
    assert_eq!(
        items[0].payload,
        json!({
            "messageId": "assistant-1",
            "content": "Hello from canonical completion"
        })
    );
    assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
    assert_eq!(items[0].updated_at, None);
}

#[test]
fn trace_projection_restores_canonical_phase_changed_without_turn_item() {
    let event = runtime_event(
        "turn-1",
        "agent.phase.changed",
        AgentRuntimePhase::CallingModel,
        None,
        1,
        json!({
            "from": "planning",
            "to": "calling_model"
        }),
    );
    let encoded = serde_json::to_value(&event).expect("serialize phase event");
    let restored: AgentRuntimeEventEnvelope =
        serde_json::from_value(encoded).expect("deserialize phase event");

    assert_eq!(restored.event_name, "agent.phase.changed");
    assert_eq!(restored.phase, AgentRuntimePhase::CallingModel);
    assert_eq!(restored.payload["to"], "calling_model");
    assert!(project_turn_items_from_trace_events(&[restored]).is_empty());
}

#[test]
fn trace_projection_combines_tool_lifecycle_into_one_item() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append_legacy_native_event(
            "agent.tool.start",
            Some("call-1".to_string()),
            "2026-07-03T00:00:01Z",
            json!({ "toolName": "workspace.read_file" }),
        ),
        appender.append_legacy_native_event(
            "agent.tool.result",
            Some("call-1".to_string()),
            "2026-07-03T00:00:02Z",
            json!({
                "toolName": "workspace.read_file",
                "envelope": {
                    "status": "ok",
                    "summary": "read README",
                    "metrics": { "durationMs": 42 }
                }
            }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "call-1");
    assert_eq!(items[0].kind, AgentTurnItemKind::ToolCall);
    assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
    assert_eq!(items[0].title.as_deref(), Some("workspace.read_file"));
    assert_eq!(items[0].summary.as_deref(), Some("read README"));
    assert_eq!(items[0].payload["status"], "completed");
    assert_eq!(items[0].payload["resultStatus"], "ok");
    assert_eq!(items[0].payload["summary"], "read README");
    assert_eq!(items[0].payload["detailId"], "tool:call-1");
    assert_eq!(
        items[0].payload["timing"],
        json!({
            "startedAt": "2026-07-03T00:00:01Z",
            "completedAt": "2026-07-03T00:00:02Z",
            "durationMs": 42
        })
    );
    assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
    assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
}

#[test]
fn trace_projection_combines_approval_request_and_decision() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append_legacy_native_event(
            "agent.awaiting_approval",
            Some("approval-1".to_string()),
            "2026-07-03T00:00:01Z",
            json!({
                "approvalId": "approval-1",
                "summary": "Allow workspace.write_file?",
                "options": [
                    { "decision": "approved", "scope": "once" },
                    { "decision": "approved", "scope": "session" },
                    { "decision": "denied" }
                ]
            }),
        ),
        appender.append_legacy_native_event(
            "agent.approval.decision",
            Some("approval-1".to_string()),
            "2026-07-03T00:00:02Z",
            json!({
                "approvalId": "approval-1",
                "decision": "denied",
                "scope": "once",
                "guidance": "Do not write files."
            }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "approval-1");
    assert_eq!(items[0].kind, AgentTurnItemKind::Approval);
    assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
    assert_eq!(
        items[0].title.as_deref(),
        Some("Allow workspace.write_file?")
    );
    assert_eq!(
        items[0].summary.as_deref(),
        Some("Allow workspace.write_file?")
    );
    assert_eq!(items[0].payload["status"], "completed");
    assert_eq!(items[0].payload["decision"], "denied");
    assert_eq!(items[0].payload["scope"], "once");
    assert_eq!(items[0].payload["guidance"], "Do not write files.");
    assert_eq!(items[0].payload["detailId"], "approval:approval-1");
    assert_eq!(
        items[0].payload["options"].as_array().map(Vec::len),
        Some(3)
    );
    assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
    assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
}

#[test]
fn trace_projection_combines_form_request_and_resolution() {
    let mut appender = AgentRuntimeEventAppender::new("session-1", "turn-1");
    let events = vec![
        appender.append_legacy_native_event(
            "agent.awaiting_form",
            Some("form-1".to_string()),
            "2026-07-03T00:00:01Z",
            json!({
                "formId": "form-1",
                "form": {
                    "title": "Configure turn",
                    "fields": [{ "name": "destination", "required": true }]
                },
                "errors": { "destination": "Required" }
            }),
        ),
        appender.append_legacy_native_event(
            "agent.form.resolution",
            Some("form-1".to_string()),
            "2026-07-03T00:00:02Z",
            json!({
                "formId": "form-1",
                "action": "submit",
                "values": { "destination": "Paris" },
                "errors": {}
            }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].item_id, "form-1");
    assert_eq!(items[0].kind, AgentTurnItemKind::Form);
    assert_eq!(items[0].status, AgentTurnItemStatus::Completed);
    assert_eq!(items[0].title.as_deref(), Some("Configure turn"));
    assert_eq!(items[0].summary.as_deref(), Some("Configure turn"));
    assert_eq!(items[0].payload["status"], "completed");
    assert_eq!(items[0].payload["action"], "submit");
    assert_eq!(items[0].payload["values"]["destination"], "Paris");
    assert_eq!(items[0].payload["detailId"], "form:form-1");
    let data = serde_json::to_value(&items[0].data).expect("form data should serialize");
    assert_eq!(data["values"]["destination"], "Paris");
    assert_eq!(data["errors"], json!({}));
    assert_eq!(items[0].created_at, "2026-07-03T00:00:01Z");
    assert_eq!(items[0].updated_at.as_deref(), Some("2026-07-03T00:00:02Z"));
}

#[test]
fn trace_projection_restores_active_terminal_and_waiting_items() {
    let events = vec![
        runtime_event(
            "turn-1",
            "agent.delta",
            AgentRuntimePhase::StreamingModel,
            None,
            1,
            json!({ "delta": "working" }),
        ),
        runtime_event(
            "turn-2",
            "agent.done",
            AgentRuntimePhase::Completed,
            None,
            1,
            json!({ "finalContent": "done" }),
        ),
        runtime_event(
            "turn-3",
            "agent.error",
            AgentRuntimePhase::Failed,
            None,
            1,
            json!({ "message": "failed" }),
        ),
        runtime_event(
            "turn-4",
            "agent.cancelled",
            AgentRuntimePhase::Cancelled,
            None,
            1,
            json!({ "message": "cancelled" }),
        ),
        runtime_event(
            "turn-5",
            "agent.awaiting_approval",
            AgentRuntimePhase::AwaitingApproval,
            Some("approval-1"),
            1,
            json!({ "approvalId": "approval-1" }),
        ),
        runtime_event(
            "turn-6",
            "agent.awaiting_form",
            AgentRuntimePhase::AwaitingForm,
            Some("form-1"),
            1,
            json!({ "formId": "form-1" }),
        ),
        runtime_event(
            "turn-7",
            "agent.delegate.running",
            AgentRuntimePhase::AwaitingSubagent,
            Some("subagent-1"),
            1,
            json!({ "delegateId": "subagent-1" }),
        ),
    ];

    let items = project_turn_items_from_trace_events(&events);

    assert_eq!(items.len(), 7);
    assert_eq!(items[0].status, AgentTurnItemStatus::Running);
    assert_eq!(items[1].status, AgentTurnItemStatus::Completed);
    assert_eq!(items[2].status, AgentTurnItemStatus::Failed);
    assert_eq!(items[3].status, AgentTurnItemStatus::Cancelled);
    assert_eq!(items[4].kind, AgentTurnItemKind::Approval);
    assert_eq!(items[4].status, AgentTurnItemStatus::Waiting);
    assert_eq!(items[5].kind, AgentTurnItemKind::Form);
    assert_eq!(items[5].status, AgentTurnItemStatus::Waiting);
    assert_eq!(items[6].kind, AgentTurnItemKind::SubagentLifecycle);
    assert_eq!(items[6].status, AgentTurnItemStatus::Waiting);
}

#[test]
fn canonical_turn_items_cover_typed_runtime_items_with_stable_revisions() {
    let events = vec![
        runtime_event(
            "turn-typed",
            "agent.plan.progress",
            AgentRuntimePhase::ToolRunning,
            Some("plan-1"),
            1,
            json!({
                "agentItem": {
                    "type": "plan_progress",
                    "id": "plan-1",
                    "summary": "Inspect repository",
                    "completed": 0,
                    "total": 2,
                    "currentStep": "Inspect repository",
                    "steps": [
                        { "step": "Inspect repository", "status": "in_progress" },
                        { "step": "Read runtime events", "status": "pending" }
                    ]
                }
            }),
        ),
        runtime_event(
            "turn-typed",
            "agent.plan.progress",
            AgentRuntimePhase::ToolRunning,
            Some("plan-1"),
            2,
            json!({
                "agentItem": {
                    "type": "plan_progress",
                    "id": "plan-1",
                    "summary": "Inspect repository",
                    "completed": 1,
                    "total": 2,
                    "currentStep": "Read runtime events",
                    "explanation": "Repository inspection is complete.",
                    "steps": [
                        { "step": "Inspect repository", "status": "completed" },
                        { "step": "Read runtime events", "status": "in_progress" }
                    ]
                }
            }),
        ),
        runtime_event(
            "turn-typed",
            "agent.context.compacted",
            AgentRuntimePhase::CallingModel,
            Some("turn-typed:context:1"),
            3,
            json!({
                "agentItem": {
                    "type": "context_compaction",
                    "id": "turn-typed:context:1",
                    "summary": "compact",
                    "droppedItemCount": 4,
                    "estimatedTokensBefore": 12000,
                    "estimatedTokensAfter": 4200
                }
            }),
        ),
        runtime_event(
            "turn-typed",
            "agent.usage",
            AgentRuntimePhase::CallingModel,
            Some("turn-typed:usage:1"),
            4,
            json!({
                "agentItem": {
                    "type": "usage",
                    "id": "turn-typed:usage:1",
                    "inputTokens": 10,
                    "outputTokens": 5,
                    "totalTokens": 15,
                    "providerPayload": {}
                }
            }),
        ),
        runtime_event(
            "turn-typed",
            "agent.file.reference",
            AgentRuntimePhase::ToolRunning,
            Some("file-1"),
            5,
            json!({
                "agentItem": {
                    "type": "file_reference",
                    "id": "file-1",
                    "path": "output/report.md",
                    "mimeType": "text/markdown",
                    "referenceKind": "file"
                }
            }),
        ),
        runtime_event(
            "turn-typed",
            "agent.cancelled",
            AgentRuntimePhase::Cancelled,
            Some("turn-typed:error:cancelled"),
            6,
            json!({
                "agentItem": {
                    "type": "error",
                    "id": "turn-typed:error:cancelled",
                    "code": "cancelled",
                    "message": "Cancelled by user",
                    "cancelled": true
                }
            }),
        ),
    ];

    let items = serde_json::to_value(project_turn_items_from_trace_events(&events))
        .expect("canonical turn items should serialize");
    let items = items.as_array().expect("turn items should be an array");

    assert_eq!(items.len(), 5);
    assert_eq!(items[0]["schemaVersion"], "tinybot.turn_item.v2");
    assert_eq!(items[0]["turnId"], "turn-typed");
    assert_eq!(items[0]["sequence"], 1);
    assert_eq!(items[0]["revision"], 2);
    assert_eq!(items[0]["kind"], "plan_progress");
    assert_eq!(items[0]["data"]["type"], "plan_progress");
    assert_eq!(items[0]["data"]["completed"], 1);
    assert_eq!(items[0]["data"]["currentStep"], "Read runtime events");
    assert_eq!(items[0]["data"]["steps"][0]["status"], "completed");
    assert_eq!(
        items[0]["data"]["explanation"],
        "Repository inspection is complete."
    );
    assert_eq!(items[1]["kind"], "context_compaction");
    assert_eq!(items[1]["data"]["estimatedTokensBefore"], 12000);
    assert_eq!(items[1]["data"]["estimatedTokensAfter"], 4200);
    assert_eq!(items[2]["kind"], "usage");
    assert_eq!(items[3]["kind"], "file_reference");
    assert_eq!(items[4]["kind"], "error");
    assert_eq!(items[4]["status"], "cancelled");
}

#[test]
fn timeline_snapshot_and_patch_share_revision_and_item_projection() {
    let events = vec![
        runtime_event(
            "turn-live",
            "agent.phase.changed",
            AgentRuntimePhase::CallingModel,
            None,
            8,
            json!({ "nextPhase": "calling_model" }),
        ),
        runtime_event(
            "turn-live",
            "agent.delta",
            AgentRuntimePhase::StreamingModel,
            Some("assistant-1"),
            7,
            json!({ "delta": "hel" }),
        ),
        runtime_event(
            "turn-live",
            "agent.delta",
            AgentRuntimePhase::StreamingModel,
            Some("assistant-1"),
            9,
            json!({ "delta": "lo" }),
        ),
    ];

    let snapshot = project_timeline_snapshot("session-1", "turn-live", &events)
        .expect("timeline snapshot should project");
    let patch = project_timeline_patch("session-1", "turn-live", &events)
        .expect("timeline patch should project")
        .expect("assistant delta should create a patch");

    assert_eq!(snapshot.schema_version, AGENT_TIMELINE_SCHEMA_VERSION);
    assert_eq!(snapshot.snapshot_revision, 0);
    assert_eq!(snapshot.items.len(), 1);
    assert_eq!(snapshot.items[0].sequence, 7);
    assert_eq!(snapshot.items[0].revision, 2);
    assert_eq!(patch.schema_version, AGENT_TIMELINE_PATCH_SCHEMA_VERSION);
    assert_eq!(patch.snapshot_revision, 0);
    assert_eq!(patch.item, snapshot.items[0]);
}

#[test]
#[should_panic(expected = "cannot transition from Completed to Running")]
fn canonical_projection_rejects_terminal_status_regression() {
    let events = vec![
        runtime_event(
            "turn-terminal",
            "agent.tool.result",
            AgentRuntimePhase::Completed,
            Some("tool-1"),
            1,
            json!({ "toolCallId": "tool-1", "toolName": "shell" }),
        ),
        runtime_event(
            "turn-terminal",
            "agent.tool.start",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            2,
            json!({ "toolCallId": "tool-1", "toolName": "shell" }),
        ),
    ];

    let _ = project_timeline_snapshot("session-1", "turn-terminal", &events);
}

#[test]
fn canonical_projection_preserves_explicit_subagent_messages() {
    let event = runtime_event(
        "turn-subagent-message",
        "agent.delegate.user_message",
        AgentRuntimePhase::AwaitingSubagent,
        Some("child-message-1"),
        1,
        json!({
            "agentItem": {
                "type": "subagent_message",
                "id": "child-message-1",
                "agentId": "child-1",
                "content": "The child found a user-relevant result.",
                "visibility": "user"
            }
        }),
    );

    let snapshot = project_timeline_snapshot("session-1", "turn-subagent-message", &[event])
        .expect("subagent message should project");

    assert_eq!(snapshot.items[0].kind, AgentTurnItemKind::SubagentMessage);
    assert_eq!(snapshot.items[0].item_id, "child-message-1");
    assert!(matches!(
        &snapshot.items[0].data,
        AgentTurnItemData::SubagentMessage { agent_id, content, .. }
            if agent_id == "child-1" && content.contains("user-relevant")
    ));
}

#[test]
fn canonical_user_item_preserves_client_event_id() {
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-client-event");
    let event = emitter.user_turn_started(
        "2026-07-11T00:00:00Z",
        Some("user-1".to_string()),
        Some("client-message-1".to_string()),
        "hello",
        Vec::new(),
    );
    let snapshot = project_timeline_snapshot("session-1", "turn-client-event", &[event])
        .expect("user item should project");
    let data = serde_json::to_value(&snapshot.items[0].data)
        .expect("canonical user data should serialize");

    assert_eq!(data["clientEventId"], "client-message-1");
}

#[test]
fn canonical_user_item_preserves_tinyos_references() {
    let event = runtime_event(
        "turn-tinyos-reference",
        "agent.turn.started",
        AgentRuntimePhase::HydratingHistory,
        Some("user-1"),
        0,
        json!({
            "userMessage": {
                "id": "user-1",
                "content": "Explain this selection",
                "references": [{
                    "kind": "reference",
                    "title": "src/main.ts · L2",
                    "type": "tinyos.file",
                    "sourcePath": "src/main.ts",
                    "sourceLine": 2,
                    "sourceText": "let value = 1;"
                }]
            }
        }),
    );
    let snapshot = project_timeline_snapshot("session-1", "turn-tinyos-reference", &[event])
        .expect("user reference should project");
    let data = serde_json::to_value(&snapshot.items[0].data)
        .expect("canonical user data should serialize");

    assert_eq!(data["references"][0]["type"], "tinyos.file");
    assert_eq!(data["references"][0]["sourcePath"], "src/main.ts");
}

#[test]
fn canonical_timeline_preserves_interleaved_model_calls_and_message_phases() {
    let events = vec![
        runtime_event(
            "turn-interleaved",
            "agent.reasoning_delta",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-call-0"),
            1,
            json!({ "delta": "Inspect the workspace.", "modelCallId": "call-0" }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.delta",
            AgentRuntimePhase::StreamingModel,
            Some("message-call-0"),
            2,
            json!({ "delta": "I will inspect the workspace.", "modelCallId": "call-0" }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.message.classified",
            AgentRuntimePhase::ToolRunning,
            Some("message-call-0"),
            3,
            json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.tool.start",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            4,
            json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file" }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.tool.result",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            5,
            json!({
                "toolCallId": "tool-1",
                "toolName": "workspace.read_file",
                "result": { "ok": true }
            }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.plan.progress",
            AgentRuntimePhase::ToolRunning,
            Some("plan-1"),
            6,
            json!({
                "id": "plan-1",
                "summary": "Inspect workspace",
                "completed": 1,
                "total": 1,
                "steps": [{ "step": "Inspect workspace", "status": "completed" }]
            }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.reasoning_delta",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-call-1"),
            7,
            json!({ "delta": "Summarize the result.", "modelCallId": "call-1" }),
        ),
        runtime_event(
            "turn-interleaved",
            "agent.message.completed",
            AgentRuntimePhase::Completed,
            Some("message-call-1"),
            8,
            json!({
                "content": "The workspace was inspected.",
                "messageId": "message-call-1",
                "modelCallId": "call-1",
                "messagePhase": "final_answer"
            }),
        ),
    ];

    let snapshot = project_timeline_snapshot("session-1", "turn-interleaved", &events)
        .expect("interleaved timeline should project");

    assert_eq!(
        snapshot
            .items
            .iter()
            .map(|item| (&item.kind, item.sequence))
            .collect::<Vec<_>>(),
        vec![
            (&AgentTurnItemKind::Reasoning, 1),
            (&AgentTurnItemKind::AssistantMessage, 2),
            (&AgentTurnItemKind::ToolCall, 4),
            (&AgentTurnItemKind::PlanProgress, 6),
            (&AgentTurnItemKind::Reasoning, 7),
            (&AgentTurnItemKind::AssistantMessage, 8),
        ]
    );
    assert!(matches!(
        &snapshot.items[1].data,
        AgentTurnItemData::AssistantMessage {
            model_call_id,
            phase: AgentAssistantMessagePhase::Commentary,
            content,
            ..
        } if model_call_id == "call-0" && content == "I will inspect the workspace."
    ));
    assert!(matches!(
        &snapshot.items[5].data,
        AgentTurnItemData::AssistantMessage {
            model_call_id,
            phase: AgentAssistantMessagePhase::FinalAnswer,
            content,
            ..
        } if model_call_id == "call-1" && content == "The workspace was inspected."
    ));
}

#[test]
fn canonical_projection_omits_non_user_reasoning() {
    let mut event = runtime_event(
        "turn-hidden-reasoning",
        "agent.reasoning_delta",
        AgentRuntimePhase::StreamingModel,
        Some("reasoning-1"),
        1,
        json!({ "delta": "private provider reasoning", "modelCallId": "call-0" }),
    );
    event.visibility = AgentRuntimeEventVisibility::Debug;

    let snapshot = project_timeline_snapshot("session-1", "turn-hidden-reasoning", &[event])
        .expect("hidden reasoning should be ignored");

    assert!(snapshot.items.is_empty());
}

#[test]
#[should_panic(expected = "cannot transition phase from Commentary to FinalAnswer")]
fn canonical_projection_rejects_reclassifying_commentary_as_final_answer() {
    let events = vec![
        runtime_event(
            "turn-phase-regression",
            "agent.message.classified",
            AgentRuntimePhase::ToolRunning,
            Some("message-1"),
            1,
            json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
        ),
        runtime_event(
            "turn-phase-regression",
            "agent.message.completed",
            AgentRuntimePhase::Completed,
            Some("message-1"),
            2,
            json!({
                "content": "Done.",
                "modelCallId": "call-0",
                "messagePhase": "final_answer"
            }),
        ),
    ];

    let _ = project_turn_items_from_trace_events(&events);
}

#[test]
fn canonical_timeline_rejects_work_after_final_answer() {
    let events = vec![
        runtime_event(
            "turn-post-final",
            "agent.message.completed",
            AgentRuntimePhase::Completed,
            Some("message-1"),
            1,
            json!({
                "content": "Done.",
                "modelCallId": "call-0",
                "messagePhase": "final_answer"
            }),
        ),
        runtime_event(
            "turn-post-final",
            "agent.tool.start",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            2,
            json!({ "toolCallId": "tool-1", "toolName": "shell" }),
        ),
    ];

    let error = project_timeline_snapshot("session-1", "turn-post-final", &events)
        .expect_err("post-final work must be rejected");

    assert!(error.contains("appears after final answer"));
}

#[test]
fn incremental_timeline_projector_matches_full_projection_at_every_event() {
    let events = vec![
        runtime_event(
            "turn-incremental",
            "agent.reasoning_delta",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-call-0"),
            1,
            json!({ "delta": "Inspect.", "modelCallId": "call-0" }),
        ),
        runtime_event(
            "turn-incremental",
            "agent.delta",
            AgentRuntimePhase::StreamingModel,
            Some("message-call-0"),
            2,
            json!({ "delta": "Checking.", "modelCallId": "call-0" }),
        ),
        runtime_event(
            "turn-incremental",
            "agent.message.classified",
            AgentRuntimePhase::ToolRunning,
            Some("message-call-0"),
            3,
            json!({ "modelCallId": "call-0", "messagePhase": "commentary" }),
        ),
        runtime_event(
            "turn-incremental",
            "agent.tool.start",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            4,
            json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file" }),
        ),
        runtime_event(
            "turn-incremental",
            "agent.tool.result",
            AgentRuntimePhase::ToolRunning,
            Some("tool-1"),
            5,
            json!({ "toolCallId": "tool-1", "toolName": "workspace.read_file", "result": { "ok": true } }),
        ),
        runtime_event(
            "turn-incremental",
            "agent.message.completed",
            AgentRuntimePhase::Completed,
            Some("message-call-1"),
            6,
            json!({
                "content": "Done.",
                "modelCallId": "call-1",
                "messagePhase": "final_answer"
            }),
        ),
    ];
    let mut projector = AgentTimelineProjector::new("session-1", "turn-incremental");
    let mut prefix = Vec::new();

    for event in events {
        prefix.push(event.clone());
        let patch = projector
            .apply_event(&event)
            .expect("incremental event should project");
        let incremental = projector
            .snapshot()
            .expect("incremental snapshot should build");
        let full = project_timeline_snapshot("session-1", "turn-incremental", &prefix)
            .expect("full snapshot should build");

        assert_eq!(incremental, full);
        if let Some(patch) = patch {
            assert_eq!(patch.snapshot_revision, full.snapshot_revision);
            assert_eq!(
                Some(&patch.item),
                full.items
                    .iter()
                    .find(|item| item.item_id == patch.item.item_id)
            );
        }
    }
}

#[test]
fn live_deltas_do_not_advance_durable_timeline_revision() {
    let events = vec![
        runtime_event(
            "turn-durable-revision",
            "agent.reasoning_delta",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-1"),
            1,
            json!({"delta": "Inspect "}),
        ),
        runtime_event(
            "turn-durable-revision",
            "agent.reasoning.completed",
            AgentRuntimePhase::StreamingModel,
            Some("reasoning-1"),
            2,
            json!({"summary": "Inspect first."}),
        ),
        runtime_event(
            "turn-durable-revision",
            "agent.delta",
            AgentRuntimePhase::Finalizing,
            Some("assistant-1"),
            3,
            json!({"delta": "Done."}),
        ),
        runtime_event(
            "turn-durable-revision",
            "agent.message.completed",
            AgentRuntimePhase::Completed,
            Some("assistant-1"),
            4,
            json!({"content": "Done.", "messagePhase": "final_answer"}),
        ),
    ];
    let mut projector = AgentTimelineProjector::new("session-1", "turn-durable-revision");
    let revisions = events
        .iter()
        .map(|event| {
            projector
                .apply_event(event)
                .unwrap()
                .map(|patch| patch.snapshot_revision)
                .unwrap()
        })
        .collect::<Vec<_>>();

    assert_eq!(revisions, vec![0, 1, 1, 2]);
    assert_eq!(projector.snapshot().unwrap().snapshot_revision, 2);
    assert_eq!(
        project_timeline_snapshot("session-1", "turn-durable-revision", &events)
            .unwrap()
            .snapshot_revision,
        2
    );
}

fn runtime_event(
    turn_id: &str,
    event_name: &str,
    phase: AgentRuntimePhase,
    item_id: Option<&str>,
    sequence: u64,
    payload: Value,
) -> AgentRuntimeEventEnvelope {
    AgentRuntimeEventEnvelope {
        schema_version: AGENT_RUNTIME_EVENT_SCHEMA_VERSION.to_string(),
        event_id: format!("{turn_id}:{event_name}:{sequence}"),
        sequence,
        session_id: "session-1".to_string(),
        thread_id: None,
        turn_id: turn_id.to_string(),
        parent_turn_id: None,
        item_id: item_id.map(str::to_string),
        event_name: event_name.to_string(),
        phase,
        timestamp: format!("2026-07-03T00:00:{sequence:02}Z"),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        trace_context: None,
        payload,
    }
}
