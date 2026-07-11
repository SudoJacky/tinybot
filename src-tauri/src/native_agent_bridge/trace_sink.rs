use crate::agent_loop_runtime_protocol::{AgentRuntimeEventEnvelope, AgentTimelinePatch};
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::{call_rust_state_service, tauri_safe_event_name};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Runtime};

#[derive(Clone)]
pub(crate) struct NativeAgentRunTraceSink {
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
}

impl NativeAgentRunTraceSink {
    pub(crate) fn new(workspace_root: PathBuf, config_snapshot: serde_json::Value) -> Self {
        Self {
            workspace_root,
            config_snapshot,
        }
    }
}

impl NativeAgentTraceSink for NativeAgentRunTraceSink {
    fn load_runtime_events(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        let generated = next_worker_request_correlation();
        let value = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                generated.id("agent-run-runtime-state"),
                generated.trace_id("agent-run-runtime-state"),
                "agent_run.runtime_state",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                }),
            ),
            "native agent run runtime state",
        )?;
        serde_json::from_value(
            value
                .get("runtimeEvents")
                .cloned()
                .ok_or_else(|| "agent run runtime state is missing runtimeEvents".to_string())?,
        )
        .map_err(|error| format!("invalid persisted runtime events: {error}"))
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let generated = next_worker_request_correlation();
        let request_id = event
            .trace_context
            .as_ref()
            .map(|trace| format!("{}:trace:{}", trace.request_id, event.event_id))
            .unwrap_or_else(|| generated.id("agent-run-append-trace"));
        let trace_id = event
            .trace_context
            .as_ref()
            .map(|trace| trace.trace_id.clone())
            .unwrap_or_else(|| generated.trace_id("agent-run-append-trace"));
        let event = serde_json::to_value(event)
            .map_err(|error| format!("native agent trace event serialization failed: {error}"))?;
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("persistence.write.started");
        let started_at = Instant::now();
        let result = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                request_id,
                trace_id,
                "agent_run.append_trace",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                    "event": event,
                }),
            ),
            "native agent run trace append",
        );
        metrics.record_duration("persistence.write.durationMs", started_at.elapsed());
        metrics.increment(if result.is_ok() {
            "persistence.write.completed"
        } else {
            "persistence.write.failed"
        });
        result.map(|_| ())
    }
}

#[derive(Clone)]
struct CompositeNativeAgentTraceSink {
    sinks: Vec<Arc<dyn NativeAgentTraceSink>>,
}

impl NativeAgentTraceSink for CompositeNativeAgentTraceSink {
    fn load_runtime_events(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        let mut first_empty = None;
        for sink in &self.sinks {
            match sink.load_runtime_events(session_id, run_id) {
                Ok(events) if !events.is_empty() => return Ok(events),
                Ok(events) => first_empty.get_or_insert(events),
                Err(error) => return Err(error),
            };
        }
        Ok(first_empty.unwrap_or_default())
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let mut first_error = None;
        for sink in &self.sinks {
            if let Err(error) = sink.append_trace_event(session_id, run_id, event) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn append_timeline_patch(
        &self,
        session_id: &str,
        run_id: &str,
        patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        let mut first_error = None;
        for sink in &self.sinks {
            if let Err(error) = sink.append_timeline_patch(session_id, run_id, patch) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

#[derive(Clone)]
struct DesktopAgentEventSink<R: Runtime + 'static> {
    app: tauri::AppHandle<R>,
}

impl<R: Runtime + 'static> NativeAgentTraceSink for DesktopAgentEventSink<R> {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let event_name = tauri_safe_event_name(&event.event_name);
        let mut payload = event.payload.clone();
        if let (Some(object), Some(trace_context)) =
            (payload.as_object_mut(), event.trace_context.as_ref())
        {
            object.insert(
                "traceContext".to_string(),
                serde_json::to_value(trace_context).map_err(|error| {
                    format!("native agent live trace context serialization failed: {error}")
                })?,
            );
        }
        self.app
            .emit(&event_name, payload)
            .map_err(|error| format!("native agent frontend event emit failed: {error}"))
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _run_id: &str,
        patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        self.app
            .emit(&tauri_safe_event_name("agent.timeline.patch"), patch)
            .map_err(|error| format!("canonical agent timeline patch emit failed: {error}"))
    }
}

pub(crate) fn desktop_agent_event_sink<R: Runtime + 'static>(
    app: tauri::AppHandle<R>,
) -> Arc<dyn NativeAgentTraceSink> {
    Arc::new(DesktopAgentEventSink { app })
}

pub(crate) fn native_agent_trace_sink(
    workspace_root: PathBuf,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Arc<dyn NativeAgentTraceSink> {
    let persisted_sink: Arc<dyn NativeAgentTraceSink> = Arc::new(NativeAgentRunTraceSink::new(
        workspace_root,
        config_snapshot,
    ));
    let Some(live_trace_sink) = live_trace_sink else {
        return persisted_sink;
    };
    Arc::new(CompositeNativeAgentTraceSink {
        sinks: vec![persisted_sink, live_trace_sink],
    })
}
