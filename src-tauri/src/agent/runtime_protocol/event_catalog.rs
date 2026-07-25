use super::{
    AgentRuntimeEventSource, AgentRuntimeEventVisibility, AgentRuntimePhase, AgentTurnItemKind,
};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(crate) enum AgentEventKind {
    TurnStarted,
    PhaseChanged,
    Status,
    ContextHydrated,
    ContextCompacted,
    ContextTrimmed,
    ContextCompactionFailed,
    HookDecision,
    Guidance,
    Paused,
    Resumed,
    ReasoningDelta,
    ReasoningCompleted,
    MessageDelta,
    MessagePhase,
    MessageClassified,
    MessageCompleted,
    ToolCallDelta,
    ToolStarted,
    ToolResult,
    ToolDebug,
    ToolCleanupTimeout,
    PlanProgress,
    TaskProgress,
    AwaitingApproval,
    ApprovalDecision,
    AwaitingForm,
    FormResolution,
    Checkpoint,
    ModelCallCompleted,
    TokenCount,
    Usage,
    FileReference,
    CommandAcknowledged,
    Done,
    Error,
    Cancelled,
    CleanupTimeout,
    DelegateLinked,
    DelegateStarted,
    DelegateRunning,
    DelegateWait,
    DelegateResult,
    DelegateNotification,
    DelegateQueried,
    DelegateUserMessage,
    DelegateMessageQueued,
    DelegateSpawned,
    DelegateMessage,
    DelegateCompleted,
    DelegateAwaitingApproval,
    DelegateCancelled,
    DelegateClosed,
    DelegateFailed,
    DelegateInterrupted,
    DelegateResumed,
    DelegateSpawnRejected,
    DelegateTraceUpdated,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DeprecatedEventKind {
    ProviderRequested,
    ProviderCompleted,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EventNameResolution {
    Canonical(AgentEventKind),
    DeprecatedIgnored(DeprecatedEventKind),
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PhaseRule {
    Fixed(AgentRuntimePhase),
    Current,
    FromPayload(&'static str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ItemIdentityRule {
    None,
    AgentItem,
    Message,
    Reasoning,
    Tool,
    Approval,
    Form,
    Delegate,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum EventDurability {
    Durable,
    Ephemeral,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LegacyPolicy {
    Include,
    Exclude,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AgentEventDefinition {
    pub(crate) wire_name: &'static str,
    pub(crate) phase: PhaseRule,
    pub(crate) source: AgentRuntimeEventSource,
    pub(crate) visibility: AgentRuntimeEventVisibility,
    pub(crate) item_kind: Option<AgentTurnItemKind>,
    pub(crate) identity: ItemIdentityRule,
    pub(crate) durability: EventDurability,
    pub(crate) legacy: LegacyPolicy,
}

impl AgentEventDefinition {
    pub(crate) fn resolve_phase(
        &self,
        current: &AgentRuntimePhase,
        payload: &Value,
    ) -> Result<AgentRuntimePhase, String> {
        match &self.phase {
            PhaseRule::Fixed(phase) => Ok(phase.clone()),
            PhaseRule::Current => Ok(current.clone()),
            PhaseRule::FromPayload(field) => {
                let value = payload.get(*field).and_then(Value::as_str).ok_or_else(|| {
                    format!(
                        "runtime event `{}` requires string phase field `{field}`",
                        self.wire_name
                    )
                })?;
                phase_from_str(value).ok_or_else(|| {
                    format!(
                        "runtime event `{}` has unsupported phase `{value}`",
                        self.wire_name
                    )
                })
            }
        }
    }

    pub(crate) fn is_durable(&self) -> bool {
        self.durability == EventDurability::Durable
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PendingAgentEvent {
    kind: AgentEventKind,
    payload: Value,
    parent_turn_id: Option<String>,
    item_id: Option<String>,
}

impl PendingAgentEvent {
    pub(crate) fn new(kind: AgentEventKind, payload: Value) -> Self {
        Self {
            kind,
            payload,
            parent_turn_id: None,
            item_id: None,
        }
    }

    pub(crate) fn try_from_wire_name(event_name: &str, payload: Value) -> Result<Self, String> {
        match resolve_event_name(event_name) {
            EventNameResolution::Canonical(kind) => Ok(Self::new(kind, payload)),
            EventNameResolution::DeprecatedIgnored(_) => Err(format!(
                "deprecated runtime event `{event_name}` cannot be emitted"
            )),
            EventNameResolution::Unknown => {
                Err(format!("unknown canonical runtime event `{event_name}`"))
            }
        }
    }

    pub(crate) fn with_parent_turn_id(mut self, parent_turn_id: Option<String>) -> Self {
        self.parent_turn_id = parent_turn_id;
        self
    }

    pub(crate) fn with_item_id(mut self, item_id: Option<String>) -> Self {
        self.item_id = item_id;
        self
    }

    pub(crate) fn kind(&self) -> AgentEventKind {
        self.kind
    }

    pub(crate) fn into_parts(self) -> (AgentEventKind, Value, Option<String>, Option<String>) {
        (self.kind, self.payload, self.parent_turn_id, self.item_id)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ToolLifecycleEvent {
    Delta(Value),
    Started(Value),
    Result(Value),
    Debug(Value),
}

impl From<ToolLifecycleEvent> for PendingAgentEvent {
    fn from(event: ToolLifecycleEvent) -> Self {
        match event {
            ToolLifecycleEvent::Delta(payload) => Self::new(AgentEventKind::ToolCallDelta, payload),
            ToolLifecycleEvent::Started(payload) => Self::new(AgentEventKind::ToolStarted, payload),
            ToolLifecycleEvent::Result(payload) => Self::new(AgentEventKind::ToolResult, payload),
            ToolLifecycleEvent::Debug(payload) => Self::new(AgentEventKind::ToolDebug, payload),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TerminalEvent {
    Done(Value),
    Error(Value),
    Cancelled(Value),
}

impl From<TerminalEvent> for PendingAgentEvent {
    fn from(event: TerminalEvent) -> Self {
        match event {
            TerminalEvent::Done(payload) => Self::new(AgentEventKind::Done, payload),
            TerminalEvent::Error(payload) => Self::new(AgentEventKind::Error, payload),
            TerminalEvent::Cancelled(payload) => Self::new(AgentEventKind::Cancelled, payload),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ModelOutputEvent {
    MessageDelta(Value),
    MessagePhase(Value),
    MessageClassified(Value),
    MessageCompleted(Value),
    ReasoningDelta(Value),
    ReasoningCompleted(Value),
    ModelCallCompleted(Value),
    Usage(Value),
}

impl From<ModelOutputEvent> for PendingAgentEvent {
    fn from(event: ModelOutputEvent) -> Self {
        match event {
            ModelOutputEvent::MessageDelta(payload) => {
                Self::new(AgentEventKind::MessageDelta, payload)
            }
            ModelOutputEvent::MessagePhase(payload) => {
                Self::new(AgentEventKind::MessagePhase, payload)
            }
            ModelOutputEvent::MessageClassified(payload) => {
                Self::new(AgentEventKind::MessageClassified, payload)
            }
            ModelOutputEvent::MessageCompleted(payload) => {
                Self::new(AgentEventKind::MessageCompleted, payload)
            }
            ModelOutputEvent::ReasoningDelta(payload) => {
                Self::new(AgentEventKind::ReasoningDelta, payload)
            }
            ModelOutputEvent::ReasoningCompleted(payload) => {
                Self::new(AgentEventKind::ReasoningCompleted, payload)
            }
            ModelOutputEvent::ModelCallCompleted(payload) => {
                Self::new(AgentEventKind::ModelCallCompleted, payload)
            }
            ModelOutputEvent::Usage(payload) => Self::new(AgentEventKind::Usage, payload),
        }
    }
}

impl AgentEventKind {
    pub(crate) const ALL: &'static [Self] = &[
        Self::TurnStarted,
        Self::PhaseChanged,
        Self::Status,
        Self::ContextHydrated,
        Self::ContextCompacted,
        Self::ContextTrimmed,
        Self::ContextCompactionFailed,
        Self::HookDecision,
        Self::Guidance,
        Self::Paused,
        Self::Resumed,
        Self::ReasoningDelta,
        Self::ReasoningCompleted,
        Self::MessageDelta,
        Self::MessagePhase,
        Self::MessageClassified,
        Self::MessageCompleted,
        Self::ToolCallDelta,
        Self::ToolStarted,
        Self::ToolResult,
        Self::ToolDebug,
        Self::ToolCleanupTimeout,
        Self::PlanProgress,
        Self::TaskProgress,
        Self::AwaitingApproval,
        Self::ApprovalDecision,
        Self::AwaitingForm,
        Self::FormResolution,
        Self::Checkpoint,
        Self::ModelCallCompleted,
        Self::TokenCount,
        Self::Usage,
        Self::FileReference,
        Self::CommandAcknowledged,
        Self::Done,
        Self::Error,
        Self::Cancelled,
        Self::CleanupTimeout,
        Self::DelegateLinked,
        Self::DelegateStarted,
        Self::DelegateRunning,
        Self::DelegateWait,
        Self::DelegateResult,
        Self::DelegateNotification,
        Self::DelegateQueried,
        Self::DelegateUserMessage,
        Self::DelegateMessageQueued,
        Self::DelegateSpawned,
        Self::DelegateMessage,
        Self::DelegateCompleted,
        Self::DelegateAwaitingApproval,
        Self::DelegateCancelled,
        Self::DelegateClosed,
        Self::DelegateFailed,
        Self::DelegateInterrupted,
        Self::DelegateResumed,
        Self::DelegateSpawnRejected,
        Self::DelegateTraceUpdated,
    ];

    pub(crate) fn definition(self) -> AgentEventDefinition {
        use AgentRuntimeEventSource::{Provider, RustBackend, Tool, User};
        use AgentRuntimeEventVisibility::{Debug, User as UserVisibility};
        use AgentRuntimePhase::{
            AwaitingApproval, AwaitingForm, CallingModel, Cancelled, Completed, Failed, Paused,
            Planning, StreamingModel, ToolCalling, ToolRunning,
        };
        use AgentTurnItemKind::{
            Approval, AssistantMessage, ContextCompaction, Error, FileReference, Form,
            PlanProgress, Reasoning, SubagentLifecycle, SubagentMessage, SystemNotice, ToolCall,
            Usage, UserMessage,
        };
        use EventDurability::{Durable, Ephemeral};
        use ItemIdentityRule::{
            AgentItem, Approval as ApprovalIdentity, Form as FormIdentity, Message,
            None as NoIdentity, Reasoning as ReasoningIdentity, Tool as ToolIdentity,
        };
        use LegacyPolicy::{Exclude, Include};

        match self {
            Self::TurnStarted => definition(
                "agent.turn.started",
                PhaseRule::Fixed(Planning),
                User,
                UserVisibility,
                Some(UserMessage),
                NoIdentity,
                Durable,
                Exclude,
            ),
            Self::PhaseChanged => definition(
                "agent.phase.changed",
                PhaseRule::FromPayload("nextPhase"),
                RustBackend,
                Debug,
                None,
                NoIdentity,
                Ephemeral,
                Exclude,
            ),
            Self::Status => definition(
                "agent.status",
                PhaseRule::FromPayload("phase"),
                RustBackend,
                UserVisibility,
                None,
                NoIdentity,
                Ephemeral,
                Exclude,
            ),
            Self::ContextHydrated => definition(
                "agent.context.hydrated",
                PhaseRule::Fixed(Planning),
                RustBackend,
                Debug,
                None,
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::ContextCompacted => definition(
                "agent.context.compacted",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(ContextCompaction),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::ContextTrimmed => definition(
                "agent.context.trimmed",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(ContextCompaction),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::ContextCompactionFailed => definition(
                "agent.context.compaction_failed",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(Error),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::HookDecision => definition(
                "agent.hook.decision",
                PhaseRule::Current,
                RustBackend,
                Debug,
                None,
                NoIdentity,
                Ephemeral,
                Exclude,
            ),
            Self::Guidance => definition(
                "agent.guidance",
                PhaseRule::Fixed(Planning),
                User,
                UserVisibility,
                None,
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::Paused => definition(
                "agent.paused",
                PhaseRule::Fixed(Paused),
                RustBackend,
                UserVisibility,
                Some(SystemNotice),
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::Resumed => definition(
                "agent.resumed",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(SystemNotice),
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::ReasoningDelta => definition(
                "agent.reasoning_delta",
                PhaseRule::Fixed(StreamingModel),
                Provider,
                UserVisibility,
                Some(Reasoning),
                ReasoningIdentity,
                Ephemeral,
                Include,
            ),
            Self::ReasoningCompleted => definition(
                "agent.reasoning.completed",
                PhaseRule::Fixed(StreamingModel),
                Provider,
                UserVisibility,
                Some(Reasoning),
                ReasoningIdentity,
                Durable,
                Include,
            ),
            Self::MessageDelta => definition(
                "agent.delta",
                PhaseRule::Fixed(StreamingModel),
                Provider,
                UserVisibility,
                Some(AssistantMessage),
                Message,
                Ephemeral,
                Include,
            ),
            Self::MessagePhase => definition(
                "agent.message.phase",
                PhaseRule::Fixed(Planning),
                Provider,
                UserVisibility,
                Some(AssistantMessage),
                Message,
                Ephemeral,
                Include,
            ),
            Self::MessageClassified => definition(
                "agent.message.classified",
                PhaseRule::Fixed(Completed),
                Provider,
                UserVisibility,
                Some(AssistantMessage),
                Message,
                Durable,
                Include,
            ),
            Self::MessageCompleted => definition(
                "agent.message.completed",
                PhaseRule::Fixed(Completed),
                Provider,
                UserVisibility,
                Some(AssistantMessage),
                Message,
                Durable,
                Include,
            ),
            Self::ToolCallDelta => definition(
                "agent.tool_call.delta",
                PhaseRule::Fixed(ToolCalling),
                Tool,
                UserVisibility,
                Some(ToolCall),
                ToolIdentity,
                Durable,
                Include,
            ),
            Self::ToolStarted => definition(
                "agent.tool.start",
                PhaseRule::Fixed(ToolRunning),
                Tool,
                UserVisibility,
                Some(ToolCall),
                ToolIdentity,
                Ephemeral,
                Include,
            ),
            Self::ToolResult => definition(
                "agent.tool.result",
                PhaseRule::Fixed(ToolRunning),
                Tool,
                UserVisibility,
                Some(ToolCall),
                ToolIdentity,
                Durable,
                Include,
            ),
            Self::ToolDebug => definition(
                "agent.tool.debug",
                PhaseRule::Fixed(Planning),
                Tool,
                Debug,
                None,
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::ToolCleanupTimeout => definition(
                "agent.tool.cleanup_timeout",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(Error),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::PlanProgress => definition(
                "agent.plan.progress",
                PhaseRule::Fixed(Planning),
                Tool,
                UserVisibility,
                Some(PlanProgress),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::TaskProgress => definition(
                "agent.task_progress",
                PhaseRule::Fixed(Planning),
                Tool,
                UserVisibility,
                Some(PlanProgress),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::AwaitingApproval => definition(
                "agent.awaiting_approval",
                PhaseRule::Fixed(AwaitingApproval),
                RustBackend,
                UserVisibility,
                Some(Approval),
                ApprovalIdentity,
                Durable,
                Include,
            ),
            Self::ApprovalDecision => definition(
                "agent.approval.decision",
                PhaseRule::Fixed(AwaitingApproval),
                User,
                UserVisibility,
                Some(Approval),
                ApprovalIdentity,
                Durable,
                Include,
            ),
            Self::AwaitingForm => definition(
                "agent.awaiting_form",
                PhaseRule::Fixed(AwaitingForm),
                RustBackend,
                UserVisibility,
                Some(Form),
                FormIdentity,
                Ephemeral,
                Include,
            ),
            Self::FormResolution => definition(
                "agent.form.resolution",
                PhaseRule::Fixed(AwaitingForm),
                User,
                UserVisibility,
                Some(Form),
                FormIdentity,
                Ephemeral,
                Include,
            ),
            Self::Checkpoint => definition(
                "agent.checkpoint",
                PhaseRule::Fixed(Planning),
                RustBackend,
                Debug,
                Some(SystemNotice),
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::ModelCallCompleted => definition(
                "agent.model_call.completed",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                None,
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::TokenCount => definition(
                "agent.token_count",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                None,
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::Usage => definition(
                "agent.usage",
                PhaseRule::Fixed(CallingModel),
                Provider,
                Debug,
                Some(Usage),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::FileReference => definition(
                "agent.file.reference",
                PhaseRule::Fixed(Planning),
                RustBackend,
                UserVisibility,
                Some(FileReference),
                AgentItem,
                Ephemeral,
                Include,
            ),
            Self::CommandAcknowledged => definition(
                "agent.command.acknowledged",
                PhaseRule::Current,
                RustBackend,
                UserVisibility,
                Some(SystemNotice),
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::Done => definition(
                "agent.done",
                PhaseRule::Fixed(Completed),
                RustBackend,
                Debug,
                Some(AssistantMessage),
                NoIdentity,
                Ephemeral,
                Include,
            ),
            Self::Error => definition(
                "agent.error",
                PhaseRule::Fixed(Failed),
                RustBackend,
                UserVisibility,
                Some(Error),
                AgentItem,
                Durable,
                Include,
            ),
            Self::Cancelled => definition(
                "agent.cancelled",
                PhaseRule::Fixed(Cancelled),
                RustBackend,
                UserVisibility,
                Some(Error),
                AgentItem,
                Durable,
                Include,
            ),
            Self::CleanupTimeout => definition(
                "agent.cleanup_timeout",
                PhaseRule::Fixed(Failed),
                RustBackend,
                UserVisibility,
                Some(Error),
                AgentItem,
                Durable,
                Include,
            ),
            Self::DelegateUserMessage | Self::DelegateMessage => {
                delegate_definition(self.delegate_wire_name(), Some(SubagentMessage), Durable)
            }
            Self::DelegateSpawned | Self::DelegateCompleted => {
                delegate_definition(self.delegate_wire_name(), Some(SubagentLifecycle), Durable)
            }
            Self::DelegateLinked
            | Self::DelegateStarted
            | Self::DelegateRunning
            | Self::DelegateWait
            | Self::DelegateResult
            | Self::DelegateNotification
            | Self::DelegateQueried
            | Self::DelegateMessageQueued
            | Self::DelegateAwaitingApproval
            | Self::DelegateCancelled
            | Self::DelegateClosed
            | Self::DelegateFailed
            | Self::DelegateInterrupted
            | Self::DelegateResumed
            | Self::DelegateSpawnRejected
            | Self::DelegateTraceUpdated => delegate_definition(
                self.delegate_wire_name(),
                Some(SubagentLifecycle),
                Ephemeral,
            ),
        }
    }

    pub(crate) fn wire_name(self) -> &'static str {
        self.definition().wire_name
    }

    pub(crate) fn delegate_action(self) -> Option<&'static str> {
        self.wire_name().strip_prefix("agent.delegate.")
    }

    fn delegate_wire_name(self) -> &'static str {
        match self {
            Self::DelegateLinked => "agent.delegate.linked",
            Self::DelegateStarted => "agent.delegate.started",
            Self::DelegateRunning => "agent.delegate.running",
            Self::DelegateWait => "agent.delegate.wait",
            Self::DelegateResult => "agent.delegate.result",
            Self::DelegateNotification => "agent.delegate.notification",
            Self::DelegateQueried => "agent.delegate.queried",
            Self::DelegateUserMessage => "agent.delegate.user_message",
            Self::DelegateMessageQueued => "agent.delegate.message_queued",
            Self::DelegateSpawned => "agent.delegate.spawned",
            Self::DelegateMessage => "agent.delegate.message",
            Self::DelegateCompleted => "agent.delegate.completed",
            Self::DelegateAwaitingApproval => "agent.delegate.awaiting_approval",
            Self::DelegateCancelled => "agent.delegate.cancelled",
            Self::DelegateClosed => "agent.delegate.closed",
            Self::DelegateFailed => "agent.delegate.failed",
            Self::DelegateInterrupted => "agent.delegate.interrupted",
            Self::DelegateResumed => "agent.delegate.resumed",
            Self::DelegateSpawnRejected => "agent.delegate.spawn_rejected",
            Self::DelegateTraceUpdated => "agent.delegate.trace.updated",
            _ => panic!("non-delegate event has no delegate wire name"),
        }
    }
}

impl DeprecatedEventKind {
    pub(crate) const ALL: &'static [Self] = &[Self::ProviderRequested, Self::ProviderCompleted];

    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::ProviderRequested => "agent.provider.requested",
            Self::ProviderCompleted => "agent.provider.completed",
        }
    }

    pub(crate) fn phase(self) -> AgentRuntimePhase {
        AgentRuntimePhase::Planning
    }

    pub(crate) fn source(self) -> AgentRuntimeEventSource {
        AgentRuntimeEventSource::Provider
    }

    pub(crate) fn visibility(self) -> AgentRuntimeEventVisibility {
        AgentRuntimeEventVisibility::Debug
    }
}

pub(crate) fn resolve_event_name(event_name: &str) -> EventNameResolution {
    if let Some(kind) = AgentEventKind::ALL
        .iter()
        .copied()
        .find(|kind| kind.wire_name() == event_name)
    {
        return EventNameResolution::Canonical(kind);
    }
    if let Some(kind) = DeprecatedEventKind::ALL
        .iter()
        .copied()
        .find(|kind| kind.wire_name() == event_name)
    {
        return EventNameResolution::DeprecatedIgnored(kind);
    }
    EventNameResolution::Unknown
}

fn definition(
    wire_name: &'static str,
    phase: PhaseRule,
    source: AgentRuntimeEventSource,
    visibility: AgentRuntimeEventVisibility,
    item_kind: Option<AgentTurnItemKind>,
    identity: ItemIdentityRule,
    durability: EventDurability,
    legacy: LegacyPolicy,
) -> AgentEventDefinition {
    AgentEventDefinition {
        wire_name,
        phase,
        source,
        visibility,
        item_kind,
        identity,
        durability,
        legacy,
    }
}

fn delegate_definition(
    wire_name: &'static str,
    item_kind: Option<AgentTurnItemKind>,
    durability: EventDurability,
) -> AgentEventDefinition {
    definition(
        wire_name,
        PhaseRule::Fixed(AgentRuntimePhase::AwaitingSubagent),
        AgentRuntimeEventSource::Subagent,
        AgentRuntimeEventVisibility::User,
        item_kind,
        ItemIdentityRule::Delegate,
        durability,
        LegacyPolicy::Include,
    )
}

fn phase_from_str(value: &str) -> Option<AgentRuntimePhase> {
    match value {
        "queued" => Some(AgentRuntimePhase::Queued),
        "hydrating_history" => Some(AgentRuntimePhase::HydratingHistory),
        "planning" => Some(AgentRuntimePhase::Planning),
        "calling_model" => Some(AgentRuntimePhase::CallingModel),
        "streaming_model" => Some(AgentRuntimePhase::StreamingModel),
        "tool_calling" => Some(AgentRuntimePhase::ToolCalling),
        "tool_running" => Some(AgentRuntimePhase::ToolRunning),
        "awaiting_approval" => Some(AgentRuntimePhase::AwaitingApproval),
        "awaiting_form" => Some(AgentRuntimePhase::AwaitingForm),
        "awaiting_subagent" => Some(AgentRuntimePhase::AwaitingSubagent),
        "paused" => Some(AgentRuntimePhase::Paused),
        "finalizing" => Some(AgentRuntimePhase::Finalizing),
        "completed" => Some(AgentRuntimePhase::Completed),
        "failed" => Some(AgentRuntimePhase::Failed),
        "cancelling" => Some(AgentRuntimePhase::Cancelling),
        "cancelled" => Some(AgentRuntimePhase::Cancelled),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn canonical_event_catalog_has_unique_non_empty_wire_names() {
        let mut names = HashSet::new();
        for kind in AgentEventKind::ALL {
            let definition = kind.definition();
            assert!(!definition.wire_name.is_empty());
            assert!(
                names.insert(definition.wire_name),
                "duplicate canonical event name {}",
                definition.wire_name
            );
        }
    }

    #[test]
    fn deprecated_provider_events_are_read_only() {
        for kind in DeprecatedEventKind::ALL {
            assert_eq!(
                resolve_event_name(kind.wire_name()),
                EventNameResolution::DeprecatedIgnored(*kind)
            );
            assert!(
                PendingAgentEvent::try_from_wire_name(kind.wire_name(), serde_json::json!({}))
                    .is_err()
            );
        }
    }

    #[test]
    fn unknown_event_names_are_not_given_default_metadata() {
        assert_eq!(
            resolve_event_name("agent.unknown"),
            EventNameResolution::Unknown
        );
        assert!(
            PendingAgentEvent::try_from_wire_name("agent.unknown", serde_json::json!({})).is_err()
        );
    }

    #[test]
    fn phase_and_status_metadata_are_payload_driven() {
        let phase = AgentEventKind::PhaseChanged
            .definition()
            .resolve_phase(
                &AgentRuntimePhase::Planning,
                &serde_json::json!({ "nextPhase": "tool_running" }),
            )
            .expect("phase transition should resolve");
        assert_eq!(phase, AgentRuntimePhase::ToolRunning);

        let status = AgentEventKind::Status
            .definition()
            .resolve_phase(
                &AgentRuntimePhase::Planning,
                &serde_json::json!({ "phase": "awaiting_form" }),
            )
            .expect("status phase should resolve");
        assert_eq!(status, AgentRuntimePhase::AwaitingForm);
    }
}
