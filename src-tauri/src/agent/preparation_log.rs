//! Application diagnostics only: these timings never enter the conversation trace sink.
use crate::agent::runtime_protocol::AgentTraceContext;
use crate::desktop::logging::{
    append_default_native_backend_log_event, NativeLogEvent, NativeLogLevel,
};
use serde::Serialize;
use std::time::Instant;

/// Sequential steps within one scope. Nested scopes have their own log entry;
/// their durations overlap the parent and must not be added to it.
pub(crate) struct PreparationLog {
    trace: AgentTraceContext,
    received_at: Instant,
    scope: &'static str,
    model_call_id: Option<String>,
    started_at: Instant,
    step_started_at: Instant,
    step: &'static str,
    steps: Vec<PreparationStep>,
    completed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparationStep {
    name: &'static str,
    start_offset_ms: u64,
    duration_ms: u64,
    outcome: &'static str,
}

impl PreparationLog {
    pub(crate) fn new(
        trace: &AgentTraceContext,
        received_at: Instant,
        scope: &'static str,
        first_step: &'static str,
    ) -> Self {
        let started_at = Instant::now();
        Self {
            trace: trace.clone(),
            received_at,
            scope,
            model_call_id: None,
            started_at,
            step_started_at: started_at,
            step: first_step,
            steps: Vec::new(),
            completed: false,
        }
    }

    pub(crate) fn next(&mut self, step: &'static str) {
        self.end_step(Instant::now(), "completed");
        self.step = step;
    }

    pub(crate) fn complete(mut self) {
        self.completed = true;
    }

    pub(crate) fn model_call(&mut self, id: &str) {
        self.model_call_id = Some(id.to_string());
    }

    fn end_step(&mut self, ended_at: Instant, outcome: &'static str) {
        self.steps.push(PreparationStep {
            name: self.step,
            start_offset_ms: self
                .step_started_at
                .duration_since(self.received_at)
                .as_millis() as u64,
            duration_ms: ended_at.duration_since(self.step_started_at).as_millis() as u64,
            outcome,
        });
        self.step_started_at = ended_at;
    }

    fn finish_event(&mut self, ended_at: Instant) -> NativeLogEvent {
        let outcome = if self.completed {
            "completed"
        } else {
            "incomplete"
        };
        self.end_step(ended_at, outcome);
        NativeLogEvent::new(
            if self.completed {
                NativeLogLevel::Info
            } else {
                NativeLogLevel::Warn
            },
            "agent.preparation",
            serde_json::json!({
                "requestId": self.trace.request_id,
                "traceId": self.trace.trace_id,
                "threadId": self.trace.thread_id,
                "turnId": self.trace.turn_id,
                "scope": self.scope,
                "modelCallId": self.model_call_id,
                "outcome": outcome,
                "startOffsetMs": self.started_at.duration_since(self.received_at).as_millis() as u64,
                "endOffsetMs": ended_at.duration_since(self.received_at).as_millis() as u64,
                "durationMs": ended_at.duration_since(self.started_at).as_millis() as u64,
                "steps": self.steps,
            }),
        )
    }
}

impl Drop for PreparationLog {
    fn drop(&mut self) {
        let event = self.finish_event(Instant::now());
        if let Err(error) = append_default_native_backend_log_event("agent", event) {
            eprintln!(
                "agent preparation diagnostic write failed: {error}; turn_id={} scope={}",
                self.trace.turn_id, self.scope,
            );
        }
    }
}
