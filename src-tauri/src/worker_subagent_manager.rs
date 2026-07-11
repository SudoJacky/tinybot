use crate::worker_background::BackgroundTraceEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

const DEFAULT_MAX_ACTIVE_SUBAGENTS_PER_SESSION: usize = 8;

#[derive(Clone, Debug)]
pub struct SubagentThreadManager {
    state: Arc<Mutex<SubagentThreadManagerState>>,
    max_active_per_session: usize,
}

#[derive(Debug, Default)]
struct SubagentThreadManagerState {
    records: HashMap<String, SubagentThreadRecord>,
    next_sequence: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentThreadStatus {
    Running,
    WaitingMainAgent,
    WaitingUser,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
    Closed,
    Interrupted,
}

impl SubagentThreadStatus {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::WaitingMainAgent => "waiting_main_agent",
            Self::WaitingUser => "waiting_user",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Closed => "closed",
            Self::Interrupted => "interrupted",
        }
    }

    fn is_active(&self) -> bool {
        matches!(
            self,
            Self::Running | Self::WaitingMainAgent | Self::WaitingUser | Self::AwaitingApproval
        )
    }

    fn accepts_input(&self) -> bool {
        matches!(
            self,
            Self::Running | Self::WaitingMainAgent | Self::WaitingUser
        )
    }

    fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Cancelled | Self::Closed | Self::Interrupted
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentInputSender {
    MainAgent,
    User,
}

impl SubagentInputSender {
    fn as_str(&self) -> &'static str {
        match self {
            Self::MainAgent => "main_agent",
            Self::User => "user",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSpawnParams {
    pub session_key: String,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub subagent_id: Option<String>,
    #[serde(default)]
    pub child_run_id: Option<String>,
    #[serde(default)]
    pub trace_ref: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub status: Option<SubagentThreadStatus>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSendInputParams {
    pub session_key: String,
    #[serde(alias = "delegateId")]
    pub subagent_id: String,
    pub content: String,
    pub sender: SubagentInputSender,
    #[serde(default)]
    pub turn_id: Option<String>,
    #[serde(default)]
    pub child_run_id: Option<String>,
    #[serde(default)]
    pub trace_ref: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTargetParams {
    pub session_key: String,
    #[serde(alias = "delegateId")]
    pub subagent_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWaitParams {
    pub session_key: String,
    #[serde(default)]
    pub subagent_ids: Vec<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTransitionParams {
    pub session_key: String,
    #[serde(alias = "delegateId")]
    pub subagent_id: String,
    pub status: SubagentThreadStatus,
    #[serde(default)]
    pub result_summary: Option<String>,
    #[serde(default)]
    pub blocker_summary: Option<String>,
    #[serde(default)]
    pub pending_approval: Option<Value>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentThreadSummary {
    pub session_key: String,
    pub parent_run_id: Option<String>,
    pub subagent_id: String,
    pub child_run_id: String,
    pub trace_ref: Option<String>,
    pub name: String,
    pub task: String,
    pub status: SubagentThreadStatus,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub mailbox_depth: usize,
    pub terminal_result: Option<String>,
    pub blocker_summary: Option<String>,
    pub pending_approval: Option<Value>,
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMailboxInput {
    pub input_id: String,
    pub sender: SubagentInputSender,
    pub content: String,
    pub created_at: String,
    pub turn_id: Option<String>,
    pub metadata: Value,
}

#[derive(Clone, Debug)]
struct SubagentThreadRecord {
    session_key: String,
    parent_run_id: Option<String>,
    subagent_id: String,
    child_run_id: String,
    trace_ref: Option<String>,
    name: String,
    task: String,
    status: SubagentThreadStatus,
    created_at: String,
    updated_at: String,
    closed_at: Option<String>,
    mailbox: VecDeque<SubagentMailboxInput>,
    terminal_result: Option<String>,
    blocker_summary: Option<String>,
    pending_approval: Option<Value>,
    metadata: Value,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentDelivery {
    LiveDelivered,
    QueuedOnly,
    Rejected,
}

impl SubagentDelivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LiveDelivered => "live_delivered",
            Self::QueuedOnly => "queued_for_runtime",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubagentControlErrorCode {
    InvalidRequest,
    NotFound,
    Forbidden,
    Inactive,
    CapacityExhausted,
    Interrupted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentControlError {
    pub code: SubagentControlErrorCode,
    pub message: String,
    pub current_status: Option<SubagentThreadStatus>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSpawnResult {
    pub accepted: bool,
    pub subagent: Option<SubagentThreadSummary>,
    pub event: Option<BackgroundTraceEvent>,
    pub error: Option<SubagentControlError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInputResult {
    pub accepted: bool,
    pub delivery: String,
    pub subagent: Option<SubagentThreadSummary>,
    pub input: Option<SubagentMailboxInput>,
    pub event: Option<BackgroundTraceEvent>,
    pub error: Option<SubagentControlError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentQueryResult {
    pub found: bool,
    pub subagent: Option<SubagentThreadSummary>,
    pub error: Option<SubagentControlError>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListResult {
    pub session_key: String,
    pub subagents: Vec<SubagentThreadSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentWaitResult {
    pub timed_out: bool,
    pub statuses: Vec<SubagentThreadSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentLifecycleResult {
    pub accepted: bool,
    pub subagent: Option<SubagentThreadSummary>,
    pub event: Option<BackgroundTraceEvent>,
    pub error: Option<SubagentControlError>,
}

impl Default for SubagentThreadManager {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_ACTIVE_SUBAGENTS_PER_SESSION)
    }
}

impl SubagentThreadManager {
    pub fn new(max_active_per_session: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(SubagentThreadManagerState {
                records: HashMap::new(),
                next_sequence: 1,
            })),
            max_active_per_session,
        }
    }

    pub fn spawn(&self, params: SubagentSpawnParams) -> SubagentSpawnResult {
        let session_key = params.session_key.trim();
        if session_key.is_empty() {
            return SubagentSpawnResult::error(invalid("session_key is required"));
        }
        let subagent_id = non_empty(params.subagent_id.as_deref())
            .unwrap_or_else(|| format!("subagent-{}", now_unix_ms()));
        let child_run_id =
            non_empty(params.child_run_id.as_deref()).unwrap_or_else(|| subagent_id.clone());
        let created_at = non_empty(params.created_at.as_deref()).unwrap_or_else(now_timestamp);
        let status = params.status.unwrap_or(SubagentThreadStatus::Running);
        let key = record_key(session_key, &subagent_id);
        let mut state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        if !state.records.contains_key(&key)
            && active_count_for_session(&state.records, session_key) >= self.max_active_per_session
        {
            let event = next_event(
                &mut state,
                "agent.delegate.spawn_rejected",
                session_key,
                params.parent_run_id.as_deref().unwrap_or("subagent-spawn"),
                &subagent_id,
                Some(&child_run_id),
                params.trace_ref.as_deref(),
                serde_json::json!({
                    "reason": "capacity_exhausted",
                    "maxActiveSubagents": self.max_active_per_session,
                    "task": params.task,
                }),
            );
            return SubagentSpawnResult {
                accepted: false,
                subagent: None,
                event: Some(event),
                error: Some(SubagentControlError {
                    code: SubagentControlErrorCode::CapacityExhausted,
                    message: "active subagent capacity exhausted".to_string(),
                    current_status: None,
                }),
            };
        }
        let record = SubagentThreadRecord {
            session_key: session_key.to_string(),
            parent_run_id: params
                .parent_run_id
                .clone()
                .and_then(|value| non_empty(Some(&value))),
            subagent_id: subagent_id.clone(),
            child_run_id: child_run_id.clone(),
            trace_ref: params
                .trace_ref
                .clone()
                .and_then(|value| non_empty(Some(&value))),
            name: non_empty(params.name.as_deref()).unwrap_or_else(|| subagent_id.clone()),
            task: non_empty(params.task.as_deref()).unwrap_or_default(),
            status,
            created_at: created_at.clone(),
            updated_at: created_at,
            closed_at: None,
            mailbox: VecDeque::new(),
            terminal_result: None,
            blocker_summary: None,
            pending_approval: None,
            metadata: params.metadata.clone(),
        };
        state.records.insert(key, record.clone());
        let event = next_event(
            &mut state,
            "agent.delegate.started",
            session_key,
            record.parent_run_id.as_deref().unwrap_or("subagent-spawn"),
            &subagent_id,
            Some(&child_run_id),
            record.trace_ref.as_deref(),
            serde_json::json!({
                "delegateId": subagent_id,
                "childRunId": child_run_id,
                "name": record.name,
                "task": record.task,
                "status": record.status.as_str(),
                "metadata": record.metadata,
            }),
        );
        SubagentSpawnResult {
            accepted: true,
            subagent: Some(record.summary()),
            event: Some(event),
            error: None,
        }
    }

    pub fn list(&self, session_key: &str) -> SubagentListResult {
        let state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let mut subagents = state
            .records
            .values()
            .filter(|record| {
                record.session_key == session_key
                    && (record.status.is_active()
                        || record.status == SubagentThreadStatus::Interrupted)
            })
            .map(SubagentThreadRecord::summary)
            .collect::<Vec<_>>();
        subagents.sort_by(|left, right| left.created_at.cmp(&right.created_at));
        SubagentListResult {
            session_key: session_key.to_string(),
            subagents,
        }
    }

    pub fn query(&self, params: SubagentTargetParams) -> SubagentQueryResult {
        let session_key = params.session_key.trim();
        let subagent_id = params.subagent_id.trim();
        if session_key.is_empty() || subagent_id.is_empty() {
            return SubagentQueryResult::error(invalid("session_key and subagent_id are required"));
        }
        let state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let Some(record) = state.records.get(&record_key(session_key, subagent_id)) else {
            return SubagentQueryResult::error(not_found(subagent_id));
        };
        SubagentQueryResult {
            found: true,
            subagent: Some(record.summary()),
            error: None,
        }
    }

    pub fn enqueue_input(&self, params: SubagentSendInputParams) -> SubagentInputResult {
        let session_key = params.session_key.trim();
        let subagent_id = params.subagent_id.trim();
        let content = params.content.trim();
        if session_key.is_empty() || subagent_id.is_empty() || content.is_empty() {
            return SubagentInputResult::error(invalid(
                "session_key, subagent_id, and content are required",
            ));
        }
        let mut state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let key = record_key(session_key, subagent_id);
        let input_sequence = state.next_sequence;
        let Some(record) = state.records.get_mut(&key) else {
            return SubagentInputResult {
                accepted: true,
                delivery: SubagentDelivery::QueuedOnly.as_str().to_string(),
                subagent: None,
                input: None,
                event: None,
                error: None,
            };
        };
        if record.status == SubagentThreadStatus::Interrupted {
            return SubagentInputResult::error(SubagentControlError {
                code: SubagentControlErrorCode::Interrupted,
                message: "subagent is interrupted and cannot accept live input".to_string(),
                current_status: Some(record.status.clone()),
            });
        }
        if !record.status.accepts_input() {
            return SubagentInputResult::error(SubagentControlError {
                code: SubagentControlErrorCode::Inactive,
                message: format!(
                    "subagent cannot accept input while {}",
                    record.status.as_str()
                ),
                current_status: Some(record.status.clone()),
            });
        }
        if let Some(child_run_id) = non_empty(params.child_run_id.as_deref()) {
            record.child_run_id = child_run_id;
        }
        if let Some(trace_ref) = non_empty(params.trace_ref.as_deref()) {
            record.trace_ref = Some(trace_ref);
        }
        let created_at = non_empty(params.created_at.as_deref()).unwrap_or_else(now_timestamp);
        let input = SubagentMailboxInput {
            input_id: format!(
                "subagent-input-{}-{input_sequence}",
                safe_event_id_part(subagent_id)
            ),
            sender: params.sender.clone(),
            content: content.to_string(),
            created_at: created_at.clone(),
            turn_id: params
                .turn_id
                .clone()
                .and_then(|value| non_empty(Some(&value))),
            metadata: params.metadata.clone(),
        };
        record.mailbox.push_back(input.clone());
        record.updated_at = created_at;
        let summary = record.summary();
        let event = next_event(
            &mut state,
            "agent.delegate.message_queued",
            session_key,
            input
                .turn_id
                .as_deref()
                .or(summary.parent_run_id.as_deref())
                .unwrap_or("subagent-direct-input"),
            subagent_id,
            Some(&summary.child_run_id),
            summary.trace_ref.as_deref(),
            serde_json::json!({
                "content": content,
                "delivery": SubagentDelivery::LiveDelivered.as_str(),
                "source": input.sender.as_str(),
                "mailboxDepth": summary.mailbox_depth,
                "metadata": input.metadata,
            }),
        );
        SubagentInputResult {
            accepted: true,
            delivery: SubagentDelivery::LiveDelivered.as_str().to_string(),
            subagent: Some(summary),
            input: Some(input),
            event: Some(event),
            error: None,
        }
    }

    pub fn consume_mailbox(&self, params: SubagentTargetParams) -> Vec<SubagentMailboxInput> {
        let mut state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let Some(record) = state
            .records
            .get_mut(&record_key(&params.session_key, &params.subagent_id))
        else {
            return Vec::new();
        };
        record.mailbox.drain(..).collect()
    }

    pub fn wait(&self, params: SubagentWaitParams) -> SubagentWaitResult {
        let state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let targets = params
            .subagent_ids
            .iter()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let statuses = state
            .records
            .values()
            .filter(|record| record.session_key == params.session_key)
            .filter(|record| targets.is_empty() || targets.contains(&record.subagent_id.as_str()))
            .map(SubagentThreadRecord::summary)
            .collect::<Vec<_>>();
        let has_ready = statuses.iter().any(|status| {
            status.status.is_terminal()
                || matches!(
                    status.status,
                    SubagentThreadStatus::WaitingMainAgent
                        | SubagentThreadStatus::WaitingUser
                        | SubagentThreadStatus::AwaitingApproval
                )
        });
        SubagentWaitResult {
            timed_out: !has_ready,
            statuses,
        }
    }

    pub fn transition(&self, params: SubagentTransitionParams) -> SubagentLifecycleResult {
        let session_key = params.session_key.trim();
        let subagent_id = params.subagent_id.trim();
        if session_key.is_empty() || subagent_id.is_empty() {
            return SubagentLifecycleResult::error(invalid(
                "session_key and subagent_id are required",
            ));
        }
        let mut state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        let Some(record) = state.records.get_mut(&record_key(session_key, subagent_id)) else {
            return SubagentLifecycleResult::error(not_found(subagent_id));
        };
        record.status = params.status.clone();
        record.updated_at = now_timestamp();
        if matches!(record.status, SubagentThreadStatus::Closed) {
            record.closed_at = Some(record.updated_at.clone());
        }
        record.terminal_result = params
            .result_summary
            .clone()
            .and_then(|value| non_empty(Some(&value)))
            .or_else(|| record.terminal_result.clone());
        record.blocker_summary = params
            .blocker_summary
            .clone()
            .and_then(|value| non_empty(Some(&value)))
            .or_else(|| record.blocker_summary.clone());
        record.pending_approval = params.pending_approval.clone().or_else(|| {
            if matches!(record.status, SubagentThreadStatus::AwaitingApproval) {
                Some(serde_json::json!({}))
            } else {
                None
            }
        });
        let summary = record.summary();
        let event_type = match summary.status {
            SubagentThreadStatus::Completed => "agent.delegate.completed",
            SubagentThreadStatus::Failed => "agent.delegate.failed",
            SubagentThreadStatus::Cancelled => "agent.delegate.cancelled",
            SubagentThreadStatus::Closed => "agent.delegate.closed",
            SubagentThreadStatus::Interrupted => "agent.delegate.interrupted",
            SubagentThreadStatus::AwaitingApproval => "agent.delegate.awaiting_approval",
            _ => "agent.delegate.running",
        };
        let event = next_event(
            &mut state,
            event_type,
            session_key,
            summary
                .parent_run_id
                .as_deref()
                .unwrap_or("subagent-lifecycle"),
            subagent_id,
            Some(&summary.child_run_id),
            summary.trace_ref.as_deref(),
            serde_json::json!({
                "status": summary.status.as_str(),
                "resultSummary": summary.terminal_result,
                "blockerSummary": summary.blocker_summary,
                "pendingApproval": summary.pending_approval,
                "metadata": params.metadata,
            }),
        );
        SubagentLifecycleResult {
            accepted: true,
            subagent: Some(summary),
            event: Some(event),
            error: None,
        }
    }

    pub fn close(&self, params: SubagentTargetParams) -> SubagentLifecycleResult {
        self.transition(SubagentTransitionParams {
            session_key: params.session_key,
            subagent_id: params.subagent_id,
            status: SubagentThreadStatus::Closed,
            result_summary: None,
            blocker_summary: None,
            pending_approval: None,
            metadata: serde_json::json!({ "source": "close" }),
        })
    }

    pub fn cancel(&self, params: SubagentTargetParams) -> SubagentLifecycleResult {
        self.transition(SubagentTransitionParams {
            session_key: params.session_key,
            subagent_id: params.subagent_id,
            status: SubagentThreadStatus::Cancelled,
            result_summary: None,
            blocker_summary: None,
            pending_approval: None,
            metadata: serde_json::json!({ "source": "cancel" }),
        })
    }

    pub fn interrupt_non_terminal(&self, session_key: &str) -> Vec<SubagentLifecycleResult> {
        let ids = {
            let state = self
                .state
                .lock()
                .expect("subagent manager lock should not be poisoned");
            state
                .records
                .values()
                .filter(|record| record.session_key == session_key && record.status.is_active())
                .map(|record| record.subagent_id.clone())
                .collect::<Vec<_>>()
        };
        ids.into_iter()
            .map(|subagent_id| {
                self.transition(SubagentTransitionParams {
                    session_key: session_key.to_string(),
                    subagent_id,
                    status: SubagentThreadStatus::Interrupted,
                    result_summary: None,
                    blocker_summary: Some(
                        "Runtime restarted before subagent completed.".to_string(),
                    ),
                    pending_approval: None,
                    metadata: serde_json::json!({ "source": "runtime_restart" }),
                })
            })
            .collect()
    }

    pub fn interrupt_all_non_terminal_for_shutdown(&self) -> Vec<SubagentLifecycleResult> {
        let mut targets = {
            let state = self
                .state
                .lock()
                .expect("subagent manager lock should not be poisoned");
            state
                .records
                .values()
                .filter(|record| record.status.is_active())
                .map(|record| (record.session_key.clone(), record.subagent_id.clone()))
                .collect::<Vec<_>>()
        };
        targets.sort();
        targets
            .into_iter()
            .map(|(session_key, subagent_id)| {
                self.transition(SubagentTransitionParams {
                    session_key,
                    subagent_id,
                    status: SubagentThreadStatus::Interrupted,
                    result_summary: None,
                    blocker_summary: Some(
                        "Application shutdown interrupted the subagent before completion."
                            .to_string(),
                    ),
                    pending_approval: None,
                    metadata: serde_json::json!({ "source": "application_shutdown" }),
                })
            })
            .collect()
    }

    pub fn restore_interrupted_from_trace_events(
        &self,
        session_key: &str,
        events: &[BackgroundTraceEvent],
    ) -> Vec<SubagentThreadSummary> {
        let mut latest_by_delegate = HashMap::<String, &BackgroundTraceEvent>::new();
        for event in events {
            if event.session_key != session_key {
                continue;
            }
            let Some(delegate_id) = event
                .delegate_id
                .as_deref()
                .filter(|value| !value.is_empty())
            else {
                continue;
            };
            let replace = latest_by_delegate
                .get(delegate_id)
                .map(|current| {
                    event
                        .sequence
                        .cmp(&current.sequence)
                        .then(event.created_at.cmp(&current.created_at))
                        .is_gt()
                })
                .unwrap_or(true);
            if replace {
                latest_by_delegate.insert(delegate_id.to_string(), event);
            }
        }

        let mut restored = Vec::new();
        let mut state = self
            .state
            .lock()
            .expect("subagent manager lock should not be poisoned");
        for (delegate_id, event) in latest_by_delegate {
            if terminal_event_type(&event.event_type) {
                continue;
            }
            let key = record_key(session_key, &delegate_id);
            if state.records.contains_key(&key) {
                continue;
            }
            let child_run_id = event
                .child_run_id
                .clone()
                .unwrap_or_else(|| delegate_id.clone());
            let record = SubagentThreadRecord {
                session_key: session_key.to_string(),
                parent_run_id: Some(event.turn_id.clone()),
                subagent_id: delegate_id.clone(),
                child_run_id,
                trace_ref: event.trace_ref.clone(),
                name: event
                    .payload
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| delegate_id.clone()),
                task: event
                    .payload
                    .get("task")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_default(),
                status: SubagentThreadStatus::Interrupted,
                created_at: event.created_at.clone(),
                updated_at: now_timestamp(),
                closed_at: None,
                mailbox: VecDeque::new(),
                terminal_result: None,
                blocker_summary: Some("Runtime restarted before subagent completed.".to_string()),
                pending_approval: None,
                metadata: serde_json::json!({
                    "source": "background_trace_restore",
                    "lastEventType": event.event_type,
                }),
            };
            restored.push(record.summary());
            state.records.insert(key, record);
        }
        restored
    }
}

impl SubagentThreadRecord {
    fn summary(&self) -> SubagentThreadSummary {
        SubagentThreadSummary {
            session_key: self.session_key.clone(),
            parent_run_id: self.parent_run_id.clone(),
            subagent_id: self.subagent_id.clone(),
            child_run_id: self.child_run_id.clone(),
            trace_ref: self.trace_ref.clone(),
            name: self.name.clone(),
            task: self.task.clone(),
            status: self.status.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
            closed_at: self.closed_at.clone(),
            mailbox_depth: self.mailbox.len(),
            terminal_result: self.terminal_result.clone(),
            blocker_summary: self.blocker_summary.clone(),
            pending_approval: self.pending_approval.clone(),
            metadata: self.metadata.clone(),
        }
    }
}

impl SubagentSpawnResult {
    fn error(error: SubagentControlError) -> Self {
        Self {
            accepted: false,
            subagent: None,
            event: None,
            error: Some(error),
        }
    }
}

impl SubagentInputResult {
    fn error(error: SubagentControlError) -> Self {
        Self {
            accepted: false,
            delivery: SubagentDelivery::Rejected.as_str().to_string(),
            subagent: None,
            input: None,
            event: None,
            error: Some(error),
        }
    }
}

impl SubagentQueryResult {
    fn error(error: SubagentControlError) -> Self {
        Self {
            found: false,
            subagent: None,
            error: Some(error),
        }
    }
}

impl SubagentLifecycleResult {
    fn error(error: SubagentControlError) -> Self {
        Self {
            accepted: false,
            subagent: None,
            event: None,
            error: Some(error),
        }
    }
}

fn next_event(
    state: &mut SubagentThreadManagerState,
    event_type: &str,
    session_key: &str,
    turn_id: &str,
    subagent_id: &str,
    child_run_id: Option<&str>,
    trace_ref: Option<&str>,
    payload: Value,
) -> BackgroundTraceEvent {
    let sequence = state.next_sequence;
    state.next_sequence += 1;
    BackgroundTraceEvent {
        event_id: format!(
            "{}-{}-{sequence}",
            event_type.replace('.', "-"),
            safe_event_id_part(subagent_id)
        ),
        event_type: event_type.to_string(),
        session_key: session_key.to_string(),
        turn_id: turn_id.to_string(),
        parent_step_id: None,
        delegate_id: Some(subagent_id.to_string()),
        child_run_id: child_run_id.map(str::to_string),
        child_step_id: None,
        trace_ref: trace_ref.map(str::to_string),
        sequence,
        created_at: now_timestamp(),
        payload,
    }
}

fn active_count_for_session(
    records: &HashMap<String, SubagentThreadRecord>,
    session_key: &str,
) -> usize {
    records
        .values()
        .filter(|record| record.session_key == session_key && record.status.is_active())
        .count()
}

fn terminal_event_type(event_type: &str) -> bool {
    matches!(
        event_type,
        "agent.delegate.completed"
            | "agent.delegate.failed"
            | "agent.delegate.cancelled"
            | "agent.delegate.closed"
            | "agent.delegate.interrupted"
    )
}

fn record_key(session_key: &str, subagent_id: &str) -> String {
    format!("{session_key}\u{1f}{subagent_id}")
}

fn invalid(message: &str) -> SubagentControlError {
    SubagentControlError {
        code: SubagentControlErrorCode::InvalidRequest,
        message: message.to_string(),
        current_status: None,
    }
}

fn not_found(subagent_id: &str) -> SubagentControlError {
    SubagentControlError {
        code: SubagentControlErrorCode::NotFound,
        message: format!("subagent `{subagent_id}` was not found"),
        current_status: None,
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_timestamp() -> String {
    now_unix_ms().to_string()
}

fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn safe_event_id_part(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "subagent".to_string()
    } else {
        sanitized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_params(session_key: &str, subagent_id: &str) -> SubagentSpawnParams {
        SubagentSpawnParams {
            session_key: session_key.to_string(),
            parent_run_id: Some("parent-run".to_string()),
            subagent_id: Some(subagent_id.to_string()),
            child_run_id: Some(format!("child-{subagent_id}")),
            trace_ref: Some(format!("trace-{subagent_id}")),
            name: Some("Researcher".to_string()),
            task: Some("Investigate a bounded topic".to_string()),
            status: None,
            created_at: Some("1000".to_string()),
            metadata: serde_json::json!({ "role": "research" }),
        }
    }

    #[test]
    fn registers_and_lists_subagents_by_session() {
        let manager = SubagentThreadManager::default();
        let result = manager.spawn(spawn_params("session-a", "worker-1"));
        assert!(result.accepted);
        assert_eq!(result.subagent.unwrap().subagent_id, "worker-1");
        assert_eq!(manager.list("session-a").subagents.len(), 1);
        assert!(manager.list("session-b").subagents.is_empty());
    }

    #[test]
    fn query_is_scoped_to_parent_session() {
        let manager = SubagentThreadManager::default();
        manager.spawn(spawn_params("session-a", "worker-1"));
        assert!(
            manager
                .query(SubagentTargetParams {
                    session_key: "session-a".to_string(),
                    subagent_id: "worker-1".to_string(),
                })
                .found
        );
        let missing = manager.query(SubagentTargetParams {
            session_key: "session-b".to_string(),
            subagent_id: "worker-1".to_string(),
        });
        assert!(!missing.found);
        assert_eq!(
            missing.error.unwrap().code,
            SubagentControlErrorCode::NotFound
        );
    }

    #[test]
    fn enforces_active_capacity_per_session() {
        let manager = SubagentThreadManager::new(1);
        assert!(
            manager
                .spawn(spawn_params("session-a", "worker-1"))
                .accepted
        );
        let rejected = manager.spawn(spawn_params("session-a", "worker-2"));
        assert!(!rejected.accepted);
        assert_eq!(
            rejected.error.unwrap().code,
            SubagentControlErrorCode::CapacityExhausted
        );
        assert!(
            manager
                .spawn(spawn_params("session-b", "worker-2"))
                .accepted
        );
    }

    #[test]
    fn queues_user_input_for_active_subagent() {
        let manager = SubagentThreadManager::default();
        manager.spawn(spawn_params("session-a", "worker-1"));
        let result = manager.enqueue_input(SubagentSendInputParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
            content: "Please continue".to_string(),
            sender: SubagentInputSender::User,
            turn_id: Some("turn-1".to_string()),
            child_run_id: None,
            trace_ref: None,
            created_at: Some("1001".to_string()),
            metadata: serde_json::json!({ "surface": "test" }),
        });
        assert!(result.accepted);
        assert_eq!(result.delivery, "live_delivered");
        assert_eq!(result.subagent.unwrap().mailbox_depth, 1);
        assert_eq!(
            result.event.unwrap().event_type,
            "agent.delegate.message_queued"
        );
        let consumed = manager.consume_mailbox(SubagentTargetParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
        });
        assert_eq!(consumed.len(), 1);
        assert_eq!(consumed[0].sender, SubagentInputSender::User);
    }

    #[test]
    fn inactive_subagent_rejects_direct_input() {
        let manager = SubagentThreadManager::default();
        manager.spawn(spawn_params("session-a", "worker-1"));
        manager.close(SubagentTargetParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
        });
        let result = manager.enqueue_input(SubagentSendInputParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
            content: "Are you there?".to_string(),
            sender: SubagentInputSender::User,
            turn_id: None,
            child_run_id: None,
            trace_ref: None,
            created_at: None,
            metadata: Value::Null,
        });
        assert!(!result.accepted);
        assert_eq!(
            result.error.unwrap().code,
            SubagentControlErrorCode::Inactive
        );
    }

    #[test]
    fn missing_subagent_falls_back_to_queued_only_delivery() {
        let manager = SubagentThreadManager::default();
        let result = manager.enqueue_input(SubagentSendInputParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
            content: "Queue this".to_string(),
            sender: SubagentInputSender::User,
            turn_id: None,
            child_run_id: None,
            trace_ref: None,
            created_at: None,
            metadata: Value::Null,
        });
        assert!(result.accepted);
        assert_eq!(result.delivery, "queued_for_runtime");
        assert!(result.subagent.is_none());
    }

    #[test]
    fn lifecycle_transitions_preserve_diagnostics() {
        let manager = SubagentThreadManager::default();
        manager.spawn(spawn_params("session-a", "worker-1"));
        let failed = manager.transition(SubagentTransitionParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-1".to_string(),
            status: SubagentThreadStatus::Failed,
            result_summary: None,
            blocker_summary: Some("tool failed".to_string()),
            pending_approval: None,
            metadata: serde_json::json!({ "error": "boom" }),
        });
        assert!(failed.accepted);
        let summary = failed.subagent.unwrap();
        assert_eq!(summary.status, SubagentThreadStatus::Failed);
        assert_eq!(summary.blocker_summary.as_deref(), Some("tool failed"));
        assert_eq!(failed.event.unwrap().event_type, "agent.delegate.failed");
    }

    #[test]
    fn restart_interrupts_non_terminal_children_only() {
        let manager = SubagentThreadManager::default();
        manager.spawn(spawn_params("session-a", "worker-1"));
        manager.spawn(spawn_params("session-a", "worker-2"));
        manager.transition(SubagentTransitionParams {
            session_key: "session-a".to_string(),
            subagent_id: "worker-2".to_string(),
            status: SubagentThreadStatus::Completed,
            result_summary: Some("done".to_string()),
            blocker_summary: None,
            pending_approval: None,
            metadata: Value::Null,
        });
        let interrupted = manager.interrupt_non_terminal("session-a");
        assert_eq!(interrupted.len(), 1);
        assert_eq!(
            interrupted[0].subagent.as_ref().unwrap().status,
            SubagentThreadStatus::Interrupted
        );
        let listed = manager.list("session-a").subagents;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, SubagentThreadStatus::Interrupted);
    }

    #[test]
    fn restores_interrupted_children_from_non_terminal_trace_events() {
        let manager = SubagentThreadManager::default();
        let restored = manager.restore_interrupted_from_trace_events(
            "session-a",
            &[
                BackgroundTraceEvent {
                    event_id: "event-running".to_string(),
                    event_type: "agent.delegate.running".to_string(),
                    session_key: "session-a".to_string(),
                    turn_id: "parent-run".to_string(),
                    parent_step_id: None,
                    delegate_id: Some("worker-1".to_string()),
                    child_run_id: Some("child-1".to_string()),
                    child_step_id: None,
                    trace_ref: Some("trace-1".to_string()),
                    sequence: 1,
                    created_at: "1000".to_string(),
                    payload: serde_json::json!({
                        "name": "Goodall",
                        "task": "Investigate"
                    }),
                },
                BackgroundTraceEvent {
                    event_id: "event-completed".to_string(),
                    event_type: "agent.delegate.completed".to_string(),
                    session_key: "session-a".to_string(),
                    turn_id: "parent-run".to_string(),
                    parent_step_id: None,
                    delegate_id: Some("worker-2".to_string()),
                    child_run_id: Some("child-2".to_string()),
                    child_step_id: None,
                    trace_ref: Some("trace-2".to_string()),
                    sequence: 2,
                    created_at: "1001".to_string(),
                    payload: serde_json::json!({ "status": "completed" }),
                },
            ],
        );
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].subagent_id, "worker-1");
        assert_eq!(restored[0].status, SubagentThreadStatus::Interrupted);
        assert_eq!(manager.list("session-a").subagents.len(), 1);
    }
}
