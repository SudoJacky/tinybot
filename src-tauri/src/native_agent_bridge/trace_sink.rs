use crate::agent_loop_runtime_protocol::AgentRuntimeEventEnvelope;
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::{call_rust_state_service, tauri_safe_event_name};
use std::path::PathBuf;
use std::sync::Arc;
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
    fn append_trace_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let event = serde_json::to_value(event)
            .map_err(|error| format!("native agent trace event serialization failed: {error}"))?;
        let request_id = next_worker_request_correlation();
        call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                request_id.id("agent-run-append-trace"),
                request_id.trace_id("agent-run-append-trace"),
                "agent_run.append_trace",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                    "event": event,
                }),
            ),
            "native agent run trace append",
        )
        .map(|_| ())
    }
}

#[derive(Clone)]
struct CompositeNativeAgentTraceSink {
    sinks: Vec<Arc<dyn NativeAgentTraceSink>>,
}

impl NativeAgentTraceSink for CompositeNativeAgentTraceSink {
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
        self.app
            .emit(&event_name, event.payload.clone())
            .map_err(|error| format!("native agent frontend event emit failed: {error}"))
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
