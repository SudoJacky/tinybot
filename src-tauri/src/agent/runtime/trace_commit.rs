use super::NativeAgentTraceSink;
use crate::agent::runtime_protocol::{
    is_durable_agent_timeline_event, AgentRuntimeEventEnvelope, AgentTimelinePatch,
    AgentTimelineProjector, AgentTurnItemData,
};
use std::fmt;
use std::sync::Arc;
use std::time::Instant;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TraceCommitStage {
    LoadHistory,
    ProjectEvent,
    PersistEvent,
    FlushPersistence,
    EmitTimelinePatch,
}

impl TraceCommitStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::LoadHistory => "load_history",
            Self::ProjectEvent => "project_event",
            Self::PersistEvent => "persist_event",
            Self::FlushPersistence => "flush_persistence",
            Self::EmitTimelinePatch => "emit_timeline_patch",
        }
    }
}

#[derive(Debug)]
pub(super) struct TraceCommitError {
    stage: TraceCommitStage,
    session_id: String,
    turn_id: String,
    event_id: Option<String>,
    event_name: Option<String>,
    event_sequence: Option<u64>,
    request_id: Option<String>,
    trace_id: Option<String>,
    source: String,
}

impl TraceCommitError {
    fn new(
        stage: TraceCommitStage,
        session_id: &str,
        turn_id: &str,
        event: Option<&AgentRuntimeEventEnvelope>,
        source: impl Into<String>,
    ) -> Self {
        let trace_context = event.and_then(|event| event.trace_context.as_ref());
        Self {
            stage,
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            event_id: event.map(|event| event.event_id.clone()),
            event_name: event.map(|event| event.event_name.clone()),
            event_sequence: event.map(|event| event.sequence),
            request_id: trace_context.map(|trace| trace.request_id.clone()),
            trace_id: trace_context.map(|trace| trace.trace_id.clone()),
            source: source.into(),
        }
    }
}

impl fmt::Display for TraceCommitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "trace commit failed: stage={} session_id={} turn_id={}",
            self.stage.as_str(),
            self.session_id,
            self.turn_id
        )?;
        if let Some(event_name) = self.event_name.as_deref() {
            write!(formatter, " event_name={event_name}")?;
        }
        if let Some(event_id) = self.event_id.as_deref() {
            write!(formatter, " event_id={event_id}")?;
        }
        if let Some(event_sequence) = self.event_sequence {
            write!(formatter, " event_sequence={event_sequence}")?;
        }
        if let Some(request_id) = self.request_id.as_deref() {
            write!(formatter, " request_id={request_id}")?;
        }
        if let Some(trace_id) = self.trace_id.as_deref() {
            write!(formatter, " trace_id={trace_id}")?;
        }
        write!(formatter, ": {}", self.source)
    }
}

impl std::error::Error for TraceCommitError {}

#[derive(Clone)]
pub(super) struct TraceCommitter {
    session_id: String,
    turn_id: String,
    sink: Option<Arc<dyn NativeAgentTraceSink>>,
    projector: AgentTimelineProjector,
}

impl TraceCommitter {
    pub(super) fn new(
        session_id: &str,
        turn_id: &str,
        sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Self {
        Self {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            sink,
            projector: AgentTimelineProjector::new(session_id, turn_id),
        }
    }

    pub(super) fn resume(
        session_id: &str,
        turn_id: &str,
        sink: Option<Arc<dyn NativeAgentTraceSink>>,
    ) -> Result<(Self, Vec<AgentRuntimeEventEnvelope>), TraceCommitError> {
        let existing = sink
            .as_ref()
            .map(|sink| sink.load_runtime_events(session_id, turn_id))
            .transpose()
            .map_err(|error| {
                TraceCommitError::new(
                    TraceCommitStage::LoadHistory,
                    session_id,
                    turn_id,
                    None,
                    error,
                )
            })?
            .unwrap_or_default();
        let projector = AgentTimelineProjector::from_events(session_id, turn_id, &existing)
            .map_err(|error| {
                TraceCommitError::new(
                    TraceCommitStage::ProjectEvent,
                    session_id,
                    turn_id,
                    existing.last(),
                    error,
                )
            })?;
        Ok((
            Self {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                sink,
                projector,
            },
            existing,
        ))
    }

    pub(super) fn commit(
        &mut self,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), TraceCommitError> {
        self.commit_batch(std::slice::from_ref(event))
    }

    pub(super) fn commit_batch(
        &mut self,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), TraceCommitError> {
        let Some(sink) = self.sink.as_ref() else {
            return Ok(());
        };
        if events.is_empty() {
            return Ok(());
        }

        let projection_started_at = Instant::now();
        let mut candidate = self.projector.clone();
        let mut patches = Vec::with_capacity(events.len());
        for event in events {
            let patch = candidate.apply_event(event).map_err(|error| {
                metrics().increment("timeline.patch.projection.failed");
                TraceCommitError::new(
                    TraceCommitStage::ProjectEvent,
                    &self.session_id,
                    &self.turn_id,
                    Some(event),
                    error,
                )
            })?;
            patches.push((event, patch));
        }
        metrics().record_duration(
            "timeline.patch.projection.durationMs",
            projection_started_at.elapsed(),
        );

        sink.append_trace_events(&self.session_id, &self.turn_id, events)
            .map_err(|error| {
                metrics().increment("trace.sink.failed");
                TraceCommitError::new(
                    TraceCommitStage::PersistEvent,
                    &self.session_id,
                    &self.turn_id,
                    events.first(),
                    error,
                )
            })?;
        if events
            .iter()
            .any(|event| is_durable_agent_timeline_event(&event.event_name))
        {
            sink.flush().map_err(|error| {
                metrics().increment("trace.sink.flush.failed");
                TraceCommitError::new(
                    TraceCommitStage::FlushPersistence,
                    &self.session_id,
                    &self.turn_id,
                    events.last(),
                    error,
                )
            })?;
        }

        for (event, patch) in patches {
            let Some(patch) = patch else {
                continue;
            };
            log_assistant_phase_classification(event, &patch);
            sink.append_timeline_patch(&self.session_id, &self.turn_id, &patch)
                .map_err(|error| {
                    metrics().increment("timeline.patch.sink.failed");
                    TraceCommitError::new(
                        TraceCommitStage::EmitTimelinePatch,
                        &self.session_id,
                        &self.turn_id,
                        Some(event),
                        error,
                    )
                })?;
        }
        self.projector = candidate;
        Ok(())
    }
}

fn metrics() -> &'static crate::runtime::observability::AgentRuntimeMetrics {
    crate::runtime::observability::global_agent_runtime_metrics()
}

fn log_assistant_phase_classification(
    event: &AgentRuntimeEventEnvelope,
    patch: &AgentTimelinePatch,
) {
    let AgentTurnItemData::AssistantMessage {
        model_call_id,
        phase,
        ..
    } = &patch.item.data
    else {
        return;
    };
    if *phase == crate::agent::runtime_protocol::AgentAssistantMessagePhase::Unknown {
        return;
    }
    let classification_source = event
        .payload
        .get("classificationSource")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_else(|| {
            if event.event_name
                == crate::agent::runtime_protocol::AgentEventKind::MessagePhase.wire_name()
            {
                "provider"
            } else {
                "runtime_projection"
            }
        });
    eprintln!(
        "agent assistant phase classified: {}",
        serde_json::json!({
            "sessionId": event.session_id,
            "turnId": event.turn_id,
            "modelCallId": model_call_id,
            "itemId": patch.item.item_id,
            "phase": phase,
            "source": classification_source,
            "sequence": patch.item.sequence,
            "revision": patch.item.revision,
        })
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::runtime_protocol::AgentTurnEmitter;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        fail_load: AtomicBool,
        fail_append: AtomicBool,
        fail_patch: AtomicBool,
        load_count: AtomicUsize,
        events: Mutex<Vec<AgentRuntimeEventEnvelope>>,
        patches: Mutex<Vec<AgentTimelinePatch>>,
    }

    impl NativeAgentTraceSink for RecordingSink {
        fn load_runtime_events(
            &self,
            _session_id: &str,
            _turn_id: &str,
        ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
            self.load_count.fetch_add(1, Ordering::Relaxed);
            if self.fail_load.load(Ordering::Relaxed) {
                return Err("load failed".to_string());
            }
            Ok(self
                .events
                .lock()
                .expect("events lock should not be poisoned")
                .clone())
        }

        fn append_trace_event(
            &self,
            _session_id: &str,
            _turn_id: &str,
            event: &AgentRuntimeEventEnvelope,
        ) -> Result<(), String> {
            if self.fail_append.load(Ordering::Relaxed) {
                return Err("append failed".to_string());
            }
            self.events
                .lock()
                .expect("events lock should not be poisoned")
                .push(event.clone());
            Ok(())
        }

        fn append_timeline_patch(
            &self,
            _session_id: &str,
            _turn_id: &str,
            patch: &AgentTimelinePatch,
        ) -> Result<(), String> {
            if self.fail_patch.load(Ordering::Relaxed) {
                return Err("patch failed".to_string());
            }
            self.patches
                .lock()
                .expect("patches lock should not be poisoned")
                .push(patch.clone());
            Ok(())
        }
    }

    #[test]
    fn resume_fails_when_history_cannot_be_loaded() {
        let sink = Arc::new(RecordingSink::default());
        sink.fail_load.store(true, Ordering::Relaxed);

        let error = TraceCommitter::resume("session-1", "turn-1", Some(sink.clone()))
            .err()
            .expect("history load should fail");

        assert!(error.to_string().contains("stage=load_history"));
        assert_eq!(sink.load_count.load(Ordering::Relaxed), 1);
        assert!(sink
            .events
            .lock()
            .expect("events lock should not be poisoned")
            .is_empty());
    }

    #[test]
    fn persistence_failure_does_not_advance_projector_or_emit_patch() {
        let sink = Arc::new(RecordingSink::default());
        sink.fail_append.store(true, Ordering::Relaxed);
        let mut committer = TraceCommitter::new("session-1", "turn-1", Some(sink.clone()));
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
        let event = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "hello");

        let error = committer
            .commit(&event)
            .expect_err("persistence should fail");
        assert!(error.to_string().contains("stage=persist_event"));
        assert!(sink
            .patches
            .lock()
            .expect("patches lock should not be poisoned")
            .is_empty());

        sink.fail_append.store(false, Ordering::Relaxed);
        committer
            .commit(&event)
            .expect("retry should use the unchanged projector");
        let patches = sink
            .patches
            .lock()
            .expect("patches lock should not be poisoned");
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].item.revision, 1);
    }

    #[test]
    fn timeline_patch_failure_is_returned_after_event_persistence() {
        let sink = Arc::new(RecordingSink::default());
        sink.fail_patch.store(true, Ordering::Relaxed);
        let mut committer = TraceCommitter::new("session-1", "turn-1", Some(sink.clone()));
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
        let event = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "hello");

        let error = committer
            .commit(&event)
            .expect_err("timeline patch should fail");

        assert!(error.to_string().contains("stage=emit_timeline_patch"));
        assert_eq!(
            sink.events
                .lock()
                .expect("events lock should not be poisoned")
                .len(),
            1
        );
    }

    #[test]
    fn projection_failure_keeps_committer_state_and_durable_history_unchanged() {
        let sink = Arc::new(RecordingSink::default());
        let mut committer = TraceCommitter::new("session-1", "turn-1", Some(sink.clone()));
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
        let final_message =
            emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "hello");
        let invalid_tool_result = emitter.tool_result(
            "unix-ms:2",
            "tool-1",
            "read_file",
            serde_json::json!({ "status": "ok" }),
        );
        committer
            .commit(&final_message)
            .expect("final message should commit");

        let error = committer
            .commit(&invalid_tool_result)
            .expect_err("work after the final answer should fail projection");

        assert!(error.to_string().contains("stage=project_event"));
        assert_eq!(
            sink.events
                .lock()
                .expect("events lock should not be poisoned")
                .len(),
            1
        );
        let snapshot = committer
            .projector
            .snapshot()
            .expect("committer projector should remain valid");
        assert_eq!(snapshot.items.len(), 1);
        assert_eq!(snapshot.snapshot_revision, 1);
    }

    #[test]
    fn resume_loads_history_once_and_reuses_it_for_projection() {
        let sink = Arc::new(RecordingSink::default());
        let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
        let existing =
            emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "hello");
        sink.events
            .lock()
            .expect("events lock should not be poisoned")
            .push(existing);

        let (_committer, events) =
            TraceCommitter::resume("session-1", "turn-1", Some(sink.clone()))
                .expect("history should load");

        assert_eq!(events.len(), 1);
        assert_eq!(sink.load_count.load(Ordering::Relaxed), 1);
    }
}
