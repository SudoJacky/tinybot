use super::{
    agent_run, replay_thread, replay_thread_transcript, thread_checkpoint_from_item,
    thread_items_from_effective_rollout, thread_meta_from_lines, EventKind, ThreadLogItem,
    ThreadLogLine, ThreadMeta, ThreadReplay,
};
use crate::worker_protocol::WorkerProtocolError;
use crate::worker_session::AgentRunRecord;
use crate::worker_thread::{ThreadCheckpoint, ThreadItem};

#[derive(Clone, Debug)]
pub(super) struct CanonicalRolloutReconstruction {
    pub(super) semantic: ThreadReplay,
    pub(super) transcript: ThreadReplay,
    pub(super) meta: ThreadMeta,
    pub(super) thread_items: Vec<ThreadItem>,
    pub(super) agent_runs: Vec<AgentRunRecord>,
    pub(super) checkpoints: Vec<ThreadCheckpoint>,
    pub(super) active_turn: bool,
}

pub(super) fn reconstruct_canonical_rollout(
    lines: &[ThreadLogLine],
) -> Result<CanonicalRolloutReconstruction, WorkerProtocolError> {
    let meta = thread_meta_from_lines(lines)?;
    let thread_id = meta.thread_id.clone();
    let session_id = meta.session_id.clone().unwrap_or_else(|| thread_id.clone());
    let semantic = replay_thread(lines)?;
    let transcript = replay_thread_transcript(lines)?;
    let thread_items =
        thread_items_from_effective_rollout(lines, &semantic.effective_line_indexes, &thread_id)?;
    let effective_lines = semantic
        .effective_line_indexes
        .iter()
        .map(|index| lines[*index].clone())
        .collect::<Vec<_>>();
    let agent_runs =
        agent_run::agent_run_records_from_lines(&session_id, &thread_id, &effective_lines)?;
    let active_turn = effective_lines.iter().fold(false, |active, line| {
        let ThreadLogItem::EventMsg(event) = &line.item else {
            return active;
        };
        match event.kind() {
            kind if kind.starts_turn() => true,
            kind if kind.ends_turn() => false,
            EventKind::UserMessage
            | EventKind::ThreadRolledBack
            | EventKind::TokenCount
            | EventKind::MetadataUpdated
            | EventKind::SessionCleared
            | EventKind::SessionTrimmed
            | EventKind::TaskProgressUpdated
            | EventKind::ThreadItem
            | EventKind::AgentRunUpsert
            | EventKind::AgentRunTrace
            | EventKind::AgentRunCheckpointSet
            | EventKind::AgentRunCheckpointClear
            | EventKind::AgentRunTerminal
            | EventKind::Legacy(_) => active,
            EventKind::TurnStarted
            | EventKind::TaskStarted
            | EventKind::TurnComplete
            | EventKind::TaskComplete
            | EventKind::TurnAborted => unreachable!("turn boundaries handled above"),
        }
    });
    let checkpoints = thread_items
        .iter()
        .filter_map(|item| thread_checkpoint_from_item(&thread_id, item))
        .collect();
    Ok(CanonicalRolloutReconstruction {
        semantic,
        transcript,
        meta,
        thread_items,
        agent_runs,
        checkpoints,
        active_turn,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worker_rollout::{
        CompactedItem, EventMsg, ResponseItem, RolloutItem, SessionMeta, TokenUsage,
        TokenUsageInfo, TurnContextItem, WorldStateItem, ROLLOUT_SCHEMA_VERSION,
    };
    use serde_json::{json, Value};

    #[test]
    fn one_rollout_drives_consistent_context_transcript_ui_runs_and_checkpoints() {
        let lines = vec![
            line(
                0,
                RolloutItem::SessionMeta(SessionMeta {
                    schema_version: ROLLOUT_SCHEMA_VERSION,
                    thread_id: "thread-child".to_string(),
                    session_id: Some("session-child".to_string()),
                    created_at: timestamp(0),
                    cwd: "D:/workspace".to_string(),
                    source: "desktop".to_string(),
                    model_provider: Some("provider-old".to_string()),
                    model: Some("model-old".to_string()),
                    base_instructions: None,
                    history_mode: Some("default".to_string()),
                    forked_from_thread_id: Some("thread-source".to_string()),
                    parent_thread_id: Some("thread-parent".to_string()),
                    originator: Some("Tinybot Desktop".to_string()),
                }),
            ),
            line(
                1,
                RolloutItem::TurnContext(turn_context("turn-1", "model-old")),
            ),
            event_line(2, EventKind::TurnStarted, json!({"turnId": "turn-1"})),
            response_line(
                3,
                json!({
                    "role": "user",
                    "content": "old question",
                    "threadItemId": "item-old",
                    "threadItemSequence": 1
                }),
            ),
            event_line(4, EventKind::TurnComplete, json!({"turnId": "turn-1"})),
            line(
                5,
                RolloutItem::Compacted(
                    CompactedItem::from_value(json!({
                        "replacementHistory": [{
                            "role": "assistant",
                            "content": "summary before current window"
                        }],
                        "windowNumber": 2,
                        "firstWindowId": "window-1",
                        "previousWindowId": "window-1",
                        "windowId": "window-2",
                        "_threadItemId": "compaction-1",
                        "_threadItemSequence": 2
                    }))
                    .unwrap(),
                ),
            ),
            line(
                6,
                RolloutItem::TurnContext(turn_context("turn-2", "model-current")),
            ),
            line(
                7,
                RolloutItem::WorldState(WorldStateItem::full(json!({
                    "environment": {"cwd": "D:/workspace", "status": "ready"}
                }))),
            ),
            event_line(
                8,
                EventKind::TurnStarted,
                json!({"runId": "run-1", "turnId": "turn-2"}),
            ),
            response_line(
                9,
                json!({
                    "role": "user",
                    "content": "current question",
                    "runId": "run-1",
                    "turnId": "turn-2",
                    "threadItemId": "item-current-user",
                    "threadItemSequence": 3
                }),
            ),
            response_line(
                10,
                json!({
                    "role": "assistant",
                    "content": "current answer",
                    "runId": "run-1",
                    "turnId": "turn-2",
                    "threadItemId": "item-current-assistant",
                    "threadItemSequence": 4
                }),
            ),
            event_line(
                11,
                EventKind::AgentRunUpsert,
                json!({"record": agent_run_record("session-child", "run-1", "turn-2")}),
            ),
            event_line(
                12,
                EventKind::AgentRunCheckpointSet,
                json!({
                    "runId": "run-1",
                    "checkpoint": {
                        "phase": "tool_execution",
                        "status": "waiting",
                        "iteration": 2,
                        "maxIterations": 8,
                        "pendingToolCalls": [{"id": "call-1"}]
                    }
                }),
            ),
            event_line(
                13,
                EventKind::ThreadItem,
                json!({
                    "item": {
                        "itemId": "checkpoint-item",
                        "threadId": "thread-child",
                        "runId": "run-1",
                        "turnId": "turn-2",
                        "sequence": 5,
                        "createdAt": timestamp(13),
                        "kind": {
                            "type": "checkpoint_created",
                            "payload": {
                                "checkpointId": "checkpoint-1",
                                "label": "before tool",
                                "restorePayload": {"cursor": 4}
                            }
                        }
                    }
                }),
            ),
            event_line(
                14,
                EventKind::TokenCount,
                json!({"tokenUsageInfo": token_usage_info(1200, 200)}),
            ),
            event_line(
                15,
                EventKind::TurnComplete,
                json!({"runId": "run-1", "turnId": "turn-2"}),
            ),
            event_line(
                16,
                EventKind::TurnStarted,
                json!({"runId": "run-discarded", "turnId": "turn-3"}),
            ),
            response_line(
                17,
                json!({
                    "role": "user",
                    "content": "discarded question",
                    "threadItemId": "item-discarded",
                    "threadItemSequence": 6
                }),
            ),
            event_line(
                18,
                EventKind::AgentRunUpsert,
                json!({
                    "record": agent_run_record(
                        "session-child",
                        "run-discarded",
                        "turn-3"
                    )
                }),
            ),
            event_line(
                19,
                EventKind::TurnComplete,
                json!({"runId": "run-discarded", "turnId": "turn-3"}),
            ),
            event_line(20, EventKind::ThreadRolledBack, json!({"numTurns": 1})),
        ];

        let reconstructed = reconstruct_canonical_rollout(&lines).unwrap();

        assert_eq!(
            reconstructed.semantic.effective_line_indexes,
            reconstructed.transcript.effective_line_indexes
        );
        assert_eq!(
            message_contents(&reconstructed.semantic.messages),
            vec![
                "summary before current window",
                "current question",
                "current answer"
            ]
        );
        assert_eq!(
            message_contents(&reconstructed.transcript.messages),
            vec!["old question", "current question", "current answer"]
        );
        assert_eq!(
            reconstructed
                .semantic
                .previous_turn_settings
                .as_ref()
                .unwrap()
                .model,
            "model-current"
        );
        assert_eq!(
            reconstructed
                .semantic
                .reference_context
                .as_ref()
                .and_then(|context| context.turn_id.as_deref()),
            Some("turn-2")
        );
        assert_eq!(reconstructed.semantic.compaction_window.window_number, 2);
        assert_eq!(
            reconstructed
                .semantic
                .compaction_window
                .window_id
                .as_deref(),
            Some("window-2")
        );
        assert_eq!(
            reconstructed.semantic.forked_from_thread_id.as_deref(),
            Some("thread-source")
        );
        assert_eq!(
            reconstructed.semantic.parent_thread_id.as_deref(),
            Some("thread-parent")
        );
        assert_eq!(
            reconstructed.semantic.world_state_baseline,
            Some(json!({
                "environment": {"cwd": "D:/workspace", "status": "ready"}
            }))
        );
        assert_eq!(
            reconstructed
                .semantic
                .token_usage_info
                .as_ref()
                .unwrap()
                .last_token_usage
                .total_tokens,
            200
        );
        assert_eq!(reconstructed.thread_items.len(), 5);
        assert!(reconstructed
            .thread_items
            .iter()
            .all(|item| item.item_id != "item-discarded"));
        assert_eq!(reconstructed.agent_runs.len(), 1);
        assert_eq!(reconstructed.agent_runs[0].run_id, "run-1");
        assert_eq!(
            reconstructed.agent_runs[0].checkpoint.as_ref().unwrap()["iteration"],
            2
        );
        assert_eq!(reconstructed.checkpoints.len(), 1);
        assert_eq!(reconstructed.checkpoints[0].checkpoint_id, "checkpoint-1");
        assert!(!reconstructed.active_turn);
    }

    #[test]
    fn malformed_agent_run_lifecycle_record_fails_reconstruction() {
        let lines = vec![
            line(
                0,
                RolloutItem::SessionMeta(SessionMeta {
                    schema_version: ROLLOUT_SCHEMA_VERSION,
                    thread_id: "thread-invalid".to_string(),
                    session_id: Some("session-invalid".to_string()),
                    created_at: timestamp(0),
                    cwd: "D:/workspace".to_string(),
                    source: "desktop".to_string(),
                    model_provider: None,
                    model: None,
                    base_instructions: None,
                    history_mode: Some("default".to_string()),
                    forked_from_thread_id: None,
                    parent_thread_id: None,
                    originator: Some("Tinybot Desktop".to_string()),
                }),
            ),
            event_line(
                1,
                EventKind::AgentRunTrace,
                json!({"runId": "missing-run", "event": {"eventId": "event-1"}}),
            ),
        ];

        let error = reconstruct_canonical_rollout(&lines).unwrap_err();

        assert_eq!(error.details["method"], "rollout.reconstruct.agent_runs");
        assert!(error.message.contains("unknown run"));
    }

    fn line(ordinal: u64, item: RolloutItem) -> ThreadLogLine {
        ThreadLogLine {
            timestamp: timestamp(ordinal),
            ordinal: Some(ordinal),
            item,
        }
    }

    fn response_line(ordinal: u64, value: Value) -> ThreadLogLine {
        line(
            ordinal,
            RolloutItem::ResponseItem(ResponseItem::from_value(value).unwrap()),
        )
    }

    fn event_line(ordinal: u64, kind: EventKind, payload: Value) -> ThreadLogLine {
        line(ordinal, RolloutItem::EventMsg(EventMsg::new(kind, payload)))
    }

    fn timestamp(ordinal: u64) -> String {
        format!("2026-07-17T10:00:{ordinal:02}Z")
    }

    fn turn_context(turn_id: &str, model: &str) -> TurnContextItem {
        TurnContextItem {
            turn_id: Some(turn_id.to_string()),
            cwd: "D:/workspace".to_string(),
            workspace_roots: Some(vec!["D:/workspace".to_string()]),
            current_date: Some("2026-07-17".to_string()),
            timezone: Some("Asia/Singapore".to_string()),
            approval_policy: json!("on-request"),
            sandbox_policy: json!({"mode": "workspace-write"}),
            permission_profile: None,
            network: None,
            model: model.to_string(),
            provider: Some("provider-current".to_string()),
            comp_hash: Some(format!("hash-{turn_id}")),
            personality: None,
            collaboration_mode: None,
            effort: None,
            summary: json!({"turnId": turn_id}),
        }
    }

    fn token_usage_info(total: i64, last: i64) -> TokenUsageInfo {
        TokenUsageInfo {
            total_token_usage: usage(total),
            last_token_usage: usage(last),
            model_context_window: Some(128_000),
        }
    }

    fn usage(total: i64) -> TokenUsage {
        TokenUsage {
            input_tokens: total / 2,
            output_tokens: total / 2,
            total_tokens: total,
            ..Default::default()
        }
    }

    fn agent_run_record(session_id: &str, run_id: &str, turn_id: &str) -> Value {
        json!({
            "sessionId": session_id,
            "runId": run_id,
            "threadId": "thread-child",
            "turnId": turn_id,
            "parentThreadId": null,
            "childThreadIds": [],
            "status": "running",
            "phase": "model",
            "startedAt": timestamp(8),
            "updatedAt": timestamp(11),
            "completedAt": null,
            "stopReason": null,
            "model": "model-current",
            "provider": "provider-current",
            "maxIterations": 8,
            "currentIteration": 1,
            "conversationMessageIds": [],
            "traceMessages": [],
            "traceEvents": [],
            "completedToolResults": [],
            "pendingToolCalls": [],
            "checkpoint": null,
            "artifacts": [],
            "usage": [],
            "tokenUsageInfo": null,
            "instructionProvenance": null,
            "instructionDiagnostics": [],
            "traceContext": null,
            "error": null
        })
    }

    fn message_contents(messages: &[Value]) -> Vec<&str> {
        messages
            .iter()
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect()
    }
}
