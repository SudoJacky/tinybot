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

    fn batch_event_ids(&self) -> Vec<Vec<String>> {
        self.batches
            .lock()
            .expect("recording trace sink lock should not be poisoned")
            .clone()
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

#[derive(Default)]
struct FailingTraceSink {
    attempts: AtomicUsize,
}

impl NativeAgentTraceSink for FailingTraceSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        unreachable!("buffered persistence should use append_trace_events")
    }

    fn append_trace_events(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), String> {
        self.attempts.fetch_add(1, Ordering::Relaxed);
        Err("durable trace write failed".to_string())
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
        phase: AgentRuntimePhase::AwaitingForm,
        timestamp: "unix-ms:3".to_string(),
        source: AgentRuntimeEventSource::RustBackend,
        visibility: AgentRuntimeEventVisibility::User,
        payload: serde_json::json!({
            "phase": "awaiting_form",
            "label": "Waiting for input",
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

#[test]
fn buffered_trace_sink_flushes_previous_turn_before_accepting_next_turn_batch() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live);
    let mut first_emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let mut second_emitter = AgentTurnEmitter::new("session-1", "turn-2");
    let first =
        first_emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "first");
    let second =
        second_emitter.message_completed("unix-ms:2", Some("message-2".to_string()), "second");

    sink.append_trace_event("session-1", "turn-1", &first)
        .expect("first turn event should enqueue");
    sink.append_trace_event("session-1", "turn-2", &second)
        .expect("second turn event should enqueue");
    sink.flush().expect("both turns should flush");

    assert_eq!(
        durable.batch_event_ids(),
        vec![vec![first.event_id], vec![second.event_id]]
    );
}

#[test]
fn buffered_trace_sink_flushes_when_batch_reaches_size_limit() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live);
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");

    for index in 0..TRACE_PERSISTENCE_BATCH_SIZE {
        let event = emitter.message_completed(
            format!("unix-ms:{index}"),
            Some(format!("message-{index}")),
            format!("content-{index}"),
        );
        sink.append_trace_event("session-1", "turn-1", &event)
            .expect("canonical event should enqueue");
    }
    sink.flush().expect("size-limited batch should flush");

    assert_eq!(durable.batch_sizes(), vec![TRACE_PERSISTENCE_BATCH_SIZE]);
}

#[test]
fn buffered_trace_sink_flushes_after_batch_window() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live);
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let event = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "first");

    sink.append_trace_event("session-1", "turn-1", &event)
        .expect("canonical event should enqueue");
    let deadline = Instant::now() + Duration::from_secs(1);
    while durable.event_count() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }

    assert_eq!(durable.event_count(), 1);
    sink.shutdown().expect("worker should shut down cleanly");
}

#[test]
fn buffered_trace_sink_keeps_first_persistence_error_terminal() {
    let durable = Arc::new(FailingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let first = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "first");
    let second = emitter.message_completed("unix-ms:2", Some("message-2".to_string()), "second");

    sink.append_trace_event("session-1", "turn-1", &first)
        .expect("first event should enqueue before the worker fails");
    let first_error = sink.flush().expect_err("first durable write should fail");
    let second_error = sink
        .append_trace_event("session-1", "turn-1", &second)
        .expect_err("terminal worker should reject later events");

    assert_eq!(first_error, "durable trace write failed");
    assert_eq!(second_error, first_error);
    assert_eq!(durable.attempts.load(Ordering::Relaxed), 1);
    assert_eq!(live.event_count(), 1);
    assert_eq!(
        sink.shutdown()
            .expect_err("shutdown should retain the first error"),
        first_error
    );
}

#[test]
fn buffered_trace_sink_shutdown_flushes_pending_batch() {
    let durable = Arc::new(RecordingTraceSink::default());
    let live = Arc::new(RecordingTraceSink::default());
    let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live);
    let mut emitter = AgentTurnEmitter::new("session-1", "turn-1");
    let event = emitter.message_completed("unix-ms:1", Some("message-1".to_string()), "first");

    sink.append_trace_event("session-1", "turn-1", &event)
        .expect("canonical event should enqueue");
    sink.shutdown().expect("shutdown should flush and join");

    assert_eq!(durable.event_count(), 1);
}
