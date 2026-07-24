use super::live_thread::LiveThread;
use super::store::{MemoryThreadStore, ThreadStore};
use super::types::{
    ContinueThreadTurnRequest, ForkThreadRequest, InterruptThreadRequest, ReadThreadRequest,
    StartThreadTurnRequest, ThreadApplyOpRequest, ThreadItem, ThreadItemKind, ThreadOp,
    ThreadStatusResult, ThreadTurnRuntimeResult, ThreadTurnSummary,
};
use crate::protocol::{WorkerProtocolError, WorkerProtocolErrorCode, WorkerProtocolErrorSource};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static TURN_ID_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static RUNTIME_ITEM_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
pub struct ThreadRuntime<S: ThreadStore = MemoryThreadStore> {
    store: S,
}

struct ThreadCompletion {
    turn_id: Option<String>,
    content: Option<String>,
    message: Value,
    stop_reason: Option<String>,
    usage: Option<Value>,
    instruction_provenance: Option<Value>,
    instruction_diagnostics: Vec<Value>,
}

impl<S: ThreadStore> ThreadRuntime<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn live_thread(&self, thread_id: impl Into<String>) -> LiveThread<S> {
        LiveThread::new(thread_id, self.store.clone())
    }

    pub fn start_turn(
        &self,
        request: StartThreadTurnRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        let thread_id = request.thread_id;
        if let Some(result) =
            self.replay_client_event_result(&thread_id, request.client_event_id.as_deref())?
        {
            return Ok(result);
        }
        let turn_id = request.turn_id.unwrap_or_else(generate_turn_id);
        let live = self.live_thread(thread_id.clone());
        live.update_metadata(request.metadata)?;
        let append = live.append_many_with_client_event_id(
            vec![
                user_message_item(&thread_id, &turn_id, request.input),
                turn_started_item(
                    &thread_id,
                    &turn_id,
                    request.model.as_deref(),
                    request.provider.as_deref(),
                    request.trace_context.as_ref(),
                ),
            ],
            request.client_event_id.as_deref(),
        )?;
        let snapshot = live.snapshot(None, None)?;
        let turn = turn_from_snapshot(&snapshot.turns, &turn_id);
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: append.items,
        })
    }

    pub fn apply_op(
        &self,
        request: ThreadApplyOpRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        match request.op {
            ThreadOp::UserInput {
                turn_id,
                input,
                model,
                provider,
                metadata,
            } => self.start_turn(StartThreadTurnRequest {
                thread_id: request.thread_id,
                client_event_id: request.client_event_id,
                turn_id,
                input,
                model,
                provider,
                metadata,
                trace_context: None,
            }),
            ThreadOp::ContinueTurn { turn_id, input } => {
                self.continue_turn(ContinueThreadTurnRequest {
                    thread_id: request.thread_id,
                    client_event_id: request.client_event_id,
                    turn_id,
                    input,
                })
            }
            ThreadOp::Interrupt { turn_id, reason } => self.interrupt(InterruptThreadRequest {
                thread_id: request.thread_id,
                client_event_id: request.client_event_id,
                turn_id,
                reason,
            }),
            ThreadOp::ApprovalRequest {
                turn_id,
                approval_id,
                summary,
                scope,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    approval_request_item(thread_id, turn_id, approval_id, summary, scope, payload)
                }
            }),
            ThreadOp::ApprovalDecision {
                turn_id,
                approval_id,
                approved,
                scope,
                guidance,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                let store = self.store.clone();
                let parent_approval_id = approval_id.clone();
                move |thread_id, turn_id| {
                    let parent_item_id = find_request_parent_item_id(
                        &store,
                        thread_id,
                        turn_id,
                        RequestParentKind::Approval(parent_approval_id.as_deref()),
                    );
                    approval_decision_item(
                        thread_id,
                        turn_id,
                        approval_id,
                        approved,
                        scope,
                        guidance,
                        payload,
                        parent_item_id,
                    )
                }
            }),
            ThreadOp::ToolCallStarted {
                turn_id,
                tool_call_id,
                tool_name,
                args,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    tool_call_started_item(thread_id, turn_id, tool_call_id, tool_name, args)
                }
            }),
            ThreadOp::ToolResult {
                turn_id,
                tool_call_id,
                tool_name,
                output,
                error,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                let store = self.store.clone();
                let parent_tool_call_id = tool_call_id.clone();
                move |thread_id, turn_id| {
                    let parent_item_id = find_request_parent_item_id(
                        &store,
                        thread_id,
                        turn_id,
                        RequestParentKind::Tool(parent_tool_call_id.as_deref()),
                    );
                    tool_result_item(
                        thread_id,
                        turn_id,
                        tool_call_id,
                        tool_name,
                        output,
                        error,
                        parent_item_id,
                    )
                }
            }),
            ThreadOp::SubagentSpawned {
                turn_id,
                subagent_id,
                child_thread_id,
                child_turn_id,
                name,
                task,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    subagent_spawned_item(
                        thread_id,
                        turn_id,
                        subagent_id,
                        child_thread_id,
                        child_turn_id,
                        name,
                        task,
                        payload,
                    )
                }
            }),
            ThreadOp::SubagentMessage {
                turn_id,
                subagent_id,
                child_thread_id,
                child_turn_id,
                content,
                status,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    subagent_message_item(
                        thread_id,
                        turn_id,
                        subagent_id,
                        child_thread_id,
                        child_turn_id,
                        content,
                        status,
                        payload,
                    )
                }
            }),
            ThreadOp::SubagentCompleted {
                turn_id,
                subagent_id,
                child_thread_id,
                child_turn_id,
                status,
                result,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    subagent_completed_item(
                        thread_id,
                        turn_id,
                        subagent_id,
                        child_thread_id,
                        child_turn_id,
                        status,
                        result,
                    )
                }
            }),
            ThreadOp::Checkpoint {
                turn_id,
                checkpoint_id,
                label,
                restore_payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    checkpoint_item(thread_id, turn_id, checkpoint_id, label, restore_payload)
                }
            }),
            ThreadOp::AssistantDelta {
                turn_id,
                delta,
                message,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    assistant_message_delta_item(thread_id, turn_id, delta, message)
                }
            }),
            ThreadOp::Reasoning {
                turn_id,
                summary,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| reasoning_item(thread_id, turn_id, summary, payload)
            }),
            ThreadOp::AgentStep {
                turn_id,
                step_id,
                name,
                status,
                summary,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    agent_step_item(thread_id, turn_id, step_id, name, status, summary, payload)
                }
            }),
            ThreadOp::RuntimeEvent {
                turn_id,
                item_id,
                event_id,
                sequence,
                timestamp,
                event_name,
                source,
                visibility,
                payload,
            } => self.apply_thread_item_op(request.thread_id, turn_id, request.client_event_id, {
                move |thread_id, turn_id| {
                    runtime_event_item(
                        thread_id, turn_id, item_id, event_id, sequence, timestamp, event_name,
                        source, visibility, payload,
                    )
                }
            }),
            ThreadOp::AssistantResponse {
                turn_id,
                content,
                message,
                stop_reason,
                usage,
                instruction_provenance,
                instruction_diagnostics,
            } => self.apply_thread_completion_op(
                request.thread_id,
                request.client_event_id,
                ThreadCompletion {
                    turn_id,
                    content,
                    message,
                    stop_reason,
                    usage,
                    instruction_provenance,
                    instruction_diagnostics,
                },
            ),
            ThreadOp::Error {
                turn_id,
                message,
                code,
                details,
            } => self.apply_thread_item_op(
                request.thread_id,
                turn_id,
                request.client_event_id,
                |thread_id, turn_id| error_item(thread_id, turn_id, message, code, details),
            ),
            ThreadOp::UpdateSettings { metadata, reason } => {
                self.apply_settings_op(request.thread_id, request.client_event_id, metadata, reason)
            }
            ThreadOp::Archive { archive_children } => {
                self.store.archive_thread_with_children(
                    &request.thread_id,
                    true,
                    archive_children,
                )?;
                self.thread_snapshot_result(request.thread_id)
            }
            ThreadOp::Unarchive { unarchive_children } => {
                self.store.archive_thread_with_children(
                    &request.thread_id,
                    false,
                    unarchive_children,
                )?;
                self.thread_snapshot_result(request.thread_id)
            }
            ThreadOp::Fork {
                title,
                fork_after_sequence,
                include_children,
                include_checkpoints,
            } => {
                let forked = self.store.fork_thread(ForkThreadRequest {
                    thread_id: request.thread_id,
                    client_event_id: request.client_event_id,
                    title,
                    fork_after_sequence,
                    include_children,
                    include_checkpoints,
                })?;
                self.thread_snapshot_result(forked.thread_id)
            }
        }
    }

    fn thread_snapshot_result(
        &self,
        thread_id: String,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        let snapshot = self.store.read_thread(ReadThreadRequest {
            thread_id,
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit: None,
        })?;
        let turn = snapshot.active_turn.clone();
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: Vec::new(),
        })
    }

    fn apply_thread_item_op<F>(
        &self,
        thread_id: String,
        turn_id: Option<String>,
        client_event_id: Option<String>,
        build_item: F,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError>
    where
        F: FnOnce(&str, &str) -> ThreadItem,
    {
        let live = self.live_thread(thread_id.clone());
        let status = self.store.get_thread_status(&thread_id)?;
        let turn_id = active_turn_id_for_thread_op(&status, &thread_id, turn_id)?;
        let append = live.append_with_client_event_id(
            build_item(&thread_id, &turn_id),
            client_event_id.as_deref(),
        )?;
        let snapshot = live.snapshot(None, None)?;
        let turn = turn_from_snapshot(&snapshot.turns, &turn_id);
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: append.items,
        })
    }

    fn apply_thread_completion_op(
        &self,
        thread_id: String,
        client_event_id: Option<String>,
        completion: ThreadCompletion,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        if let Some(result) =
            self.replay_client_event_result(&thread_id, client_event_id.as_deref())?
        {
            return Ok(result);
        }
        let live = self.live_thread(thread_id.clone());
        let status = self.store.get_thread_status(&thread_id)?;
        let turn_id = active_turn_id_for_thread_op(&status, &thread_id, completion.turn_id)?;
        let append = live.append_many_with_client_event_id(
            vec![
                assistant_message_completed_item(
                    &thread_id,
                    &turn_id,
                    completion.content,
                    completion.message,
                    completion.usage.clone(),
                ),
                turn_completed_item(
                    &thread_id,
                    &turn_id,
                    completion.stop_reason,
                    completion.usage,
                    completion.instruction_provenance,
                    completion.instruction_diagnostics,
                ),
            ],
            client_event_id.as_deref(),
        )?;
        let snapshot = live.snapshot(None, None)?;
        let turn = turn_from_snapshot(&snapshot.turns, &turn_id);
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: append.items,
        })
    }

    fn replay_client_event_result(
        &self,
        thread_id: &str,
        client_event_id: Option<&str>,
    ) -> Result<Option<ThreadTurnRuntimeResult>, WorkerProtocolError> {
        let Some(client_event_id) = client_event_id else {
            return Ok(None);
        };
        let Some(appended_items) = self.store.client_event_items(thread_id, client_event_id)?
        else {
            return Ok(None);
        };
        let snapshot = self.store.read_thread(ReadThreadRequest {
            thread_id: thread_id.to_string(),
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit: None,
        })?;
        let turn = appended_items
            .first()
            .and_then(|item| turn_from_snapshot(&snapshot.turns, &item.turn_id));
        Ok(Some(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items,
        }))
    }

    fn apply_settings_op(
        &self,
        thread_id: String,
        client_event_id: Option<String>,
        metadata: super::types::ThreadMetadataPatch,
        reason: Option<String>,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        if let Some(result) =
            self.replay_client_event_result(&thread_id, client_event_id.as_deref())?
        {
            return Ok(result);
        }
        let live = self.live_thread(thread_id.clone());
        live.update_metadata(metadata.clone())?;
        let status = self.store.get_thread_status(&thread_id)?;
        let active_turn_id = status.active_turn.as_ref().map(|turn| turn.turn_id.clone());
        let appended_items = if let Some(turn_id) = active_turn_id.as_deref() {
            live.append_with_client_event_id(
                settings_changed_item(&thread_id, turn_id, metadata, reason),
                client_event_id.as_deref(),
            )?
            .items
        } else {
            live.append_many_with_client_event_id(Vec::new(), client_event_id.as_deref())?
                .items
        };
        let snapshot = live.snapshot(None, None)?;
        let turn = active_turn_id
            .as_deref()
            .and_then(|turn_id| turn_from_snapshot(&snapshot.turns, turn_id));
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items,
        })
    }

    pub fn continue_turn(
        &self,
        request: ContinueThreadTurnRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        let thread_id = request.thread_id;
        if let Some(result) =
            self.replay_client_event_result(&thread_id, request.client_event_id.as_deref())?
        {
            return Ok(result);
        }
        let live = self.live_thread(thread_id.clone());
        let status = self.store.get_thread_status(&thread_id)?;
        let turn_id = active_turn_id_for_thread_op(&status, &thread_id, request.turn_id)?;
        let append = live.append_with_client_event_id(
            continuation_item(&thread_id, &turn_id, request.input),
            request.client_event_id.as_deref(),
        )?;
        let snapshot = live.snapshot(None, None)?;
        let turn = turn_from_snapshot(&snapshot.turns, &turn_id);
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: append.items,
        })
    }

    pub fn interrupt(
        &self,
        request: InterruptThreadRequest,
    ) -> Result<ThreadTurnRuntimeResult, WorkerProtocolError> {
        let thread_id = request.thread_id;
        if let Some(result) =
            self.replay_client_event_result(&thread_id, request.client_event_id.as_deref())?
        {
            return Ok(result);
        }
        let live = self.live_thread(thread_id.clone());
        let status = self.store.get_thread_status(&thread_id)?;
        let turn_id = request
            .turn_id
            .or_else(|| status.active_turn.as_ref().map(|turn| turn.turn_id.clone()));
        let Some(turn_id) = turn_id else {
            let snapshot = live.snapshot(None, None)?;
            return Ok(ThreadTurnRuntimeResult {
                snapshot,
                turn: None,
                appended_items: Vec::new(),
            });
        };
        let append = live.append_with_client_event_id(
            cancelled_item(&thread_id, &turn_id, request.reason),
            request.client_event_id.as_deref(),
        )?;
        let snapshot = live.snapshot(None, None)?;
        let turn = turn_from_snapshot(&snapshot.turns, &turn_id);
        Ok(ThreadTurnRuntimeResult {
            snapshot,
            turn,
            appended_items: append.items,
        })
    }
}

enum RequestParentKind<'a> {
    Approval(Option<&'a str>),
    Tool(Option<&'a str>),
}

fn find_request_parent_item_id<S: ThreadStore>(
    store: &S,
    thread_id: &str,
    turn_id: &str,
    kind: RequestParentKind<'_>,
) -> Option<String> {
    let snapshot = store
        .read_thread(ReadThreadRequest {
            thread_id: thread_id.to_string(),
            cursor: None,
            before_sequence: None,
            checkpoint_sequence: None,
            checkpoint_id: None,
            limit: None,
        })
        .ok()?;
    snapshot
        .items
        .iter()
        .rev()
        .find(|item| item.turn_id == turn_id && request_parent_kind_matches(item, &kind))
        .map(|item| item.item_id.clone())
}

fn request_parent_kind_matches(item: &ThreadItem, kind: &RequestParentKind<'_>) -> bool {
    match (&item.kind, kind) {
        (ThreadItemKind::ApprovalRequested(payload), RequestParentKind::Approval(Some(id))) => {
            payload_string(payload, &["approvalId", "approval_id"]) == Some(*id)
        }
        (ThreadItemKind::ToolCallStarted(payload), RequestParentKind::Tool(Some(id))) => {
            payload_string(payload, &["toolCallId", "tool_call_id"]) == Some(*id)
        }
        _ => false,
    }
}

fn payload_string<'a>(payload: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(value) = payload.get(*key).and_then(Value::as_str) {
            return Some(value);
        }
        if let Some(value) = payload
            .get("payload")
            .and_then(|nested| nested.get(*key))
            .and_then(Value::as_str)
        {
            return Some(value);
        }
    }
    None
}

fn user_message_item(thread_id: &str, turn_id: &str, input: Value) -> ThreadItem {
    let payload = normalize_user_input(input);
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:user"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::UserMessage(payload),
    }
}

fn turn_started_item(
    thread_id: &str,
    turn_id: &str,
    model: Option<&str>,
    provider: Option<&str>,
    trace_context: Option<&crate::agent::runtime_protocol::AgentTraceContext>,
) -> ThreadItem {
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:started"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::TurnStarted(json!({
            "turnId": turn_id,
            "model": model,
            "provider": provider,
            "traceContext": trace_context,
            "source": "thread.start_turn"
        })),
    }
}

fn continuation_item(thread_id: &str, turn_id: &str, input: Value) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:continue:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::Event(json!({
            "eventName": "thread.continue_turn",
            "payload": normalize_user_input(input)
        })),
    }
}

fn cancelled_item(thread_id: &str, turn_id: &str, reason: Option<String>) -> ThreadItem {
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:cancelled"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::Cancelled(json!({
            "turnId": turn_id,
            "reason": reason,
            "source": "thread.interrupt"
        })),
    }
}

fn approval_request_item(
    thread_id: &str,
    turn_id: &str,
    approval_id: Option<String>,
    summary: Option<String>,
    scope: Option<String>,
    payload: Value,
) -> ThreadItem {
    let approval_id = approval_id.unwrap_or_else(|| format!("approval-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:approval-request:{approval_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::ApprovalRequested(json!({
            "approvalId": approval_id,
            "turnId": turn_id,
            "summary": summary,
            "scope": scope,
            "payload": payload,
            "source": "thread.apply_op"
        })),
    }
}

fn approval_decision_item(
    thread_id: &str,
    turn_id: &str,
    approval_id: Option<String>,
    approved: bool,
    scope: Option<String>,
    guidance: Option<String>,
    payload: Value,
    parent_item_id: Option<String>,
) -> ThreadItem {
    let approval_id = approval_id.unwrap_or_else(|| format!("approval-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:approval:{approval_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::ApprovalResolved(json!({
            "approvalId": approval_id,
            "approved": approved,
            "scope": scope,
            "guidance": guidance,
            "payload": payload,
            "source": "thread.apply_op"
        })),
    }
}

fn tool_call_started_item(
    thread_id: &str,
    turn_id: &str,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    args: Value,
) -> ThreadItem {
    let tool_call_id =
        tool_call_id.unwrap_or_else(|| format!("tool-call-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:tool-call:{tool_call_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::ToolCallStarted(json!({
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "turnId": turn_id,
            "args": args,
            "source": "thread.apply_op"
        })),
    }
}

fn tool_result_item(
    thread_id: &str,
    turn_id: &str,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    output: Value,
    error: Option<Value>,
    parent_item_id: Option<String>,
) -> ThreadItem {
    let tool_call_id =
        tool_call_id.unwrap_or_else(|| format!("tool-call-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:tool-result:{tool_call_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::ToolCallOutput(json!({
            "toolCallId": tool_call_id,
            "toolName": tool_name,
            "output": output,
            "error": error,
            "source": "thread.apply_op"
        })),
    }
}

fn subagent_spawned_item(
    thread_id: &str,
    turn_id: &str,
    subagent_id: Option<String>,
    child_thread_id: Option<String>,
    child_turn_id: Option<String>,
    name: Option<String>,
    task: Option<String>,
    payload: Value,
) -> ThreadItem {
    let subagent_id = subagent_id.unwrap_or_else(|| format!("subagent-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:subagent:{subagent_id}:spawned"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::SubagentSpawned(json!({
            "subagentId": subagent_id,
            "childThreadId": child_thread_id,
            "childTurnId": child_turn_id,
            "turnId": turn_id,
            "name": name,
            "task": task,
            "payload": payload,
            "source": "thread.apply_op"
        })),
    }
}

fn subagent_message_item(
    thread_id: &str,
    turn_id: &str,
    subagent_id: Option<String>,
    child_thread_id: Option<String>,
    child_turn_id: Option<String>,
    content: Option<String>,
    status: Option<String>,
    payload: Value,
) -> ThreadItem {
    let subagent_id = subagent_id.unwrap_or_else(|| format!("subagent-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:subagent:{subagent_id}:message:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::SubagentMessage(json!({
            "subagentId": subagent_id,
            "childThreadId": child_thread_id,
            "childTurnId": child_turn_id,
            "turnId": turn_id,
            "content": content,
            "status": status,
            "payload": payload,
            "source": "thread.apply_op"
        })),
    }
}

fn subagent_completed_item(
    thread_id: &str,
    turn_id: &str,
    subagent_id: Option<String>,
    child_thread_id: Option<String>,
    child_turn_id: Option<String>,
    status: Option<String>,
    result: Value,
) -> ThreadItem {
    let subagent_id = subagent_id.unwrap_or_else(|| format!("subagent-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:subagent:{subagent_id}:completed"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::SubagentCompleted(json!({
            "subagentId": subagent_id,
            "childThreadId": child_thread_id,
            "childTurnId": child_turn_id,
            "turnId": turn_id,
            "status": status,
            "result": result,
            "source": "thread.apply_op"
        })),
    }
}

fn checkpoint_item(
    thread_id: &str,
    turn_id: &str,
    checkpoint_id: Option<String>,
    label: Option<String>,
    restore_payload: Value,
) -> ThreadItem {
    let checkpoint_id =
        checkpoint_id.unwrap_or_else(|| format!("checkpoint-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:checkpoint:{checkpoint_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::CheckpointCreated(json!({
            "checkpointId": checkpoint_id,
            "turnId": turn_id,
            "label": label,
            "restorePayload": restore_payload,
            "source": "thread.apply_op"
        })),
    }
}

fn assistant_message_delta_item(
    thread_id: &str,
    turn_id: &str,
    delta: Option<String>,
    message: Value,
) -> ThreadItem {
    let payload = if message.is_null() {
        json!({
            "delta": delta.unwrap_or_default(),
            "source": "thread.apply_op"
        })
    } else {
        json!({
            "message": message,
            "delta": delta,
            "source": "thread.apply_op"
        })
    };
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:assistant-delta:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::AssistantMessageDelta(payload),
    }
}

fn reasoning_item(
    thread_id: &str,
    turn_id: &str,
    summary: Option<String>,
    payload: Value,
) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:reasoning:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::Reasoning(json!({
            "summary": summary,
            "payload": payload,
            "source": "thread.apply_op"
        })),
    }
}

fn agent_step_item(
    thread_id: &str,
    turn_id: &str,
    step_id: Option<String>,
    name: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    payload: Value,
) -> ThreadItem {
    let step_id = step_id.unwrap_or_else(|| format!("step-{}", next_runtime_item_id()));
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:step:{step_id}"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::TurnStep(json!({
            "eventName": "agent.step",
            "stepId": step_id,
            "turnId": turn_id,
            "name": name,
            "status": status,
            "summary": summary,
            "payload": {
                "stepId": step_id,
                "name": name,
                "status": status,
                "summary": summary,
                "details": payload
            },
            "source": "thread.apply_op"
        })),
    }
}

fn runtime_event_item(
    thread_id: &str,
    turn_id: &str,
    projected_item_id: Option<String>,
    event_id: Option<String>,
    sequence: Option<u64>,
    timestamp: Option<String>,
    event_name: String,
    source: Option<String>,
    visibility: Option<String>,
    payload: Value,
) -> ThreadItem {
    let item_id = event_id
        .as_deref()
        .map(str::trim)
        .filter(|event_id| !event_id.is_empty())
        .map(|event_id| format!("thread-runtime:{thread_id}:{turn_id}:event-id:{event_id}"))
        .unwrap_or_else(|| {
            format!(
                "thread-runtime:{thread_id}:{turn_id}:event:{}",
                next_runtime_item_id()
            )
        });
    let event_payload = json!({
        "itemId": projected_item_id,
        "eventId": event_id,
        "sequence": sequence,
        "timestamp": timestamp,
        "eventName": event_name,
        "turnId": turn_id,
        "source": source,
        "visibility": visibility,
        "payload": payload,
        "threadSource": "thread.apply_op"
    });
    let kind = match event_payload.get("eventName").and_then(Value::as_str) {
        Some("agent.context.compacted") => ThreadItemKind::ContextCompaction(event_payload),
        Some("agent.context.trimmed") => ThreadItemKind::ContextTrimmed(event_payload),
        _ => ThreadItemKind::Event(event_payload),
    };
    ThreadItem {
        item_id,
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind,
    }
}

fn assistant_message_completed_item(
    thread_id: &str,
    turn_id: &str,
    content: Option<String>,
    message: Value,
    usage: Option<Value>,
) -> ThreadItem {
    let payload = if message.is_null() {
        json!({
            "text": content.unwrap_or_default(),
            "usage": usage,
            "source": "thread.apply_op"
        })
    } else {
        json!({
            "message": message,
            "text": content,
            "usage": usage,
            "source": "thread.apply_op"
        })
    };
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:assistant:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::AssistantMessageCompleted(payload),
    }
}

fn turn_completed_item(
    thread_id: &str,
    turn_id: &str,
    stop_reason: Option<String>,
    usage: Option<Value>,
    instruction_provenance: Option<Value>,
    instruction_diagnostics: Vec<Value>,
) -> ThreadItem {
    ThreadItem {
        item_id: format!("thread-runtime:{thread_id}:{turn_id}:completed"),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::TurnCompleted(json!({
            "turnId": turn_id,
            "stopReason": stop_reason,
            "usage": usage,
            "instructionProvenance": instruction_provenance,
            "instructionDiagnostics": instruction_diagnostics,
            "source": "thread.apply_op"
        })),
    }
}

fn error_item(
    thread_id: &str,
    turn_id: &str,
    message: Option<String>,
    code: Option<String>,
    details: Value,
) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:{turn_id}:error:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::Error(json!({
            "turnId": turn_id,
            "message": message.unwrap_or_else(|| "thread operation failed".to_string()),
            "code": code,
            "details": details,
            "source": "thread.apply_op"
        })),
    }
}

fn settings_changed_item(
    thread_id: &str,
    turn_id: &str,
    metadata: super::types::ThreadMetadataPatch,
    reason: Option<String>,
) -> ThreadItem {
    ThreadItem {
        item_id: format!(
            "thread-runtime:{thread_id}:settings:{}",
            next_runtime_item_id()
        ),
        thread_id: String::new(),
        turn_id: turn_id.to_string(),
        parent_item_id: None,
        sequence: 0,
        created_at: String::new(),
        kind: ThreadItemKind::SettingsChanged(json!({
            "metadata": metadata,
            "reason": reason,
            "source": "thread.apply_op"
        })),
    }
}

fn normalize_user_input(input: Value) -> Value {
    match input {
        Value::String(text) => json!({ "text": text }),
        Value::Object(_) => input,
        other => json!({ "content": other }),
    }
}

fn turn_from_snapshot(turns: &[ThreadTurnSummary], turn_id: &str) -> Option<ThreadTurnSummary> {
    turns.iter().find(|turn| turn.turn_id == turn_id).cloned()
}

fn active_turn_id_for_thread_op(
    status: &ThreadStatusResult,
    thread_id: &str,
    requested_turn_id: Option<String>,
) -> Result<String, WorkerProtocolError> {
    if let Some(turn_id) = requested_turn_id {
        if status
            .turns
            .iter()
            .any(|turn| turn.turn_id == turn_id && turn.active)
        {
            return Ok(turn_id);
        }
        return Err(thread_op_targets_inactive_turn(thread_id, &turn_id));
    }
    status
        .active_turn
        .as_ref()
        .map(|turn| turn.turn_id.clone())
        .ok_or_else(|| thread_op_requires_active_turn(thread_id))
}

fn thread_op_requires_active_turn(thread_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "thread operation requires an active turn or explicit turnId",
        json!({ "threadId": thread_id }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn thread_op_targets_inactive_turn(thread_id: &str, turn_id: &str) -> WorkerProtocolError {
    WorkerProtocolError::new(
        WorkerProtocolErrorCode::InvalidProtocol,
        "thread operation targets a turn that is not active",
        json!({
            "threadId": thread_id,
            "turnId": turn_id,
        }),
        false,
        WorkerProtocolErrorSource::RustCore,
    )
}

fn generate_turn_id() -> String {
    format!(
        "turn-{}",
        TURN_ID_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1
    )
}

fn next_runtime_item_id() -> u64 {
    RUNTIME_ITEM_SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
