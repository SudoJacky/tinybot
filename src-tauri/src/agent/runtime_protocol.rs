mod wire;

pub use wire::*;

mod event_catalog;

pub(crate) use event_catalog::{
    resolve_event_name, AgentEventKind, EventNameResolution, ItemIdentityRule, LegacyPolicy,
    ModelOutputEvent, PendingAgentEvent, PhaseRule, TerminalEvent, ToolLifecycleEvent,
};

mod appender;
mod legacy_projection;
mod timeline_projection;

#[cfg(test)]
pub use appender::AgentRuntimeEventAppender;
pub use appender::AgentTurnEmitter;
pub use legacy_projection::project_legacy_native_agent_event;
#[cfg(test)]
pub use legacy_projection::project_legacy_native_agent_events;
#[cfg(test)]
pub use timeline_projection::project_timeline_patch;
pub use timeline_projection::{
    is_durable_agent_timeline_event, project_timeline_snapshot,
    project_turn_items_from_trace_events, AgentTimelineProjector,
};

#[cfg(test)]
#[path = "runtime_protocol_tests.rs"]
mod tests;
