use super::*;
use crate::agent::runtime_protocol::{
    AgentRuntimeEventAppendInput, AgentRuntimeEventSource, AgentRuntimeEventVisibility,
    AgentRuntimePhase, AgentTurnEmitter,
};

#[derive(Default)]
struct RecordingTraceSink {
    delay: Duration,
    batches: Mutex<Vec<Vec<String>>>,
}

impl RecordingTraceSink {
    fn with_delay(delay: Duration) -> Self {
        Self {
            delay,
            batches: Mutex::new(Vec::new()),
        }
    }

    fn event_count(&self) -> usize {
        self.batches
            .lock()
            .expect("recording trace sink lock should not be poisoned")
            .iter()
            .map(Vec::len)
            .sum()
    }

    fn batch_sizes(&self) -> Vec<usize> {
        self.batches
            .lock()
            .expect("recording trace sink lock should not be poisoned")
            .iter()
            .map(Vec::len)
            .collect()
    }
}

impl NativeAgentTraceSink for RecordingTraceSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.append_trace_events("", "", std::slice::from_ref(event))
    }

    fn append_trace_events(
        &self,
        _session_id: &str,
        _turn_id: &str,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), String> {
        if !self.delay.is_zero() {
            std::thread::sleep(self.delay);
        }
        self.batches
            .lock()
            .expect("recording trace sink lock should not be poisoned")
            .push(events.iter().map(|event| event.event_id.clone()).collect());
        Ok(())
    }
}

#[test]
fn buffered_trace_sink_keeps_delta_live_without_durable_persistence() {
    let durable = Arc::new(RecordingTraceSink::with_delay(Duration::from_millis(200)));
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let event = emitter.assistant_delta("unix-ms:1", "hello");

    let started_at = Instant::now();
    sink.append_trace_event("session-1", "turn-1", &event)
        .expect("live trace event should enqueue");

    assert!(
        started_at.elapsed() < Duration::from_millis(100),
        "live trace event waited for durable persistence"
    );
    assert_eq!(live.event_count(), 1);
    assert_eq!(durable.event_count(), 0);
    sink.flush().expect("durable trace should flush");
    assert_eq!(durable.event_count(), 0);
}

#[test]
fn buffered_trace_sink_does_not_queue_adjacent_delta_events_for_persistence() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let first = emitter.assistant_delta("unix-ms:1", "hel");
    let second = emitter.assistant_delta("unix-ms:2", "lo");

    sink.append_trace_event("session-1", "turn-1", &first)
        .expect("first event should enqueue");
    sink.append_trace_event("session-1", "turn-1", &second)
        .expect("second event should enqueue");
    sink.flush().expect("durable trace should flush");

    assert_eq!(live.event_count(), 2);
    assert!(durable.batch_sizes().is_empty());
    assert_eq!(durable.event_count(), 0);
}

#[test]
fn buffered_trace_sink_batches_adjacent_canonical_events_until_explicit_flush() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let first = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "first");
    let second = emitter.message_completed("unix-ms:2", Some("message-2".to_string()), "second");

    sink.append_trace_event("session-1", "turn-1", &first)
        .expect("first event should enqueue");
    sink.append_trace_event("session-1", "turn-1", &second)
        .expect("second event should enqueue");
    sink.flush().expect("durable trace should flush");

    assert_eq!(live.event_count(), 2);
    assert_eq!(durable.batch_sizes(), vec![2]);
}

#[test]
fn buffered_trace_sink_keeps_all_status_progress_live_only() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let phase = emitter.emit(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.phase.changed".to_string(),
        phase: AgentRuntimePhase::Planning,
        timestamp: "unix-ms:1".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::Debug,
        payload: serde_json::json!({
            "previousPhase": "queued",
            "nextPhase": "planning",
            "iteration": 1,
        }),
    });
    let status = emitter.emit(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.status".to_string(),
        phase: AgentRuntimePhase::Planning,
        timestamp: "unix-ms:2".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        payload: serde_json::json!({
            "phase": "planning",
            "label": "Planning",
            "iteration": 1,
            "isBlocking": false,
        }),
    });
    let blocking_status = emitter.emit(AgentRuntimeEventAppendInput {
        parent_turn_id: None,
        item_id: None,
        event_name: "agent.status".to_string(),
        phase: AgentRuntimePhase::AwaitingApproval,
        timestamp: "unix-ms:3".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        payload: serde_json::json!({
            "phase": "awaiting_approval",
            "label": "Waiting for approval",
            "iteration": 1,
            "isBlocking": true,
        }),
    });

    sink.append_trace_event("session-1", "turn-1", &phase)
        .expect("phase event should remain live");
    sink.append_trace_event("session-1", "turn-1", &status)
        .expect("status event should remain live");
    sink.append_trace_event("session-1", "turn-1", &blocking_status)
        .expect("blocking status should remain live");
    assert_eq!(durable.event_count(), 0);
    sink.flush().expect("trace sink should flush");

    assert_eq!(live.event_count(), 3);
    assert_eq!(durable.event_count(), 0);
}
