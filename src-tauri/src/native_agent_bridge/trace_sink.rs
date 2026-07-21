use super::result_projection::native_agent_canonical_trace_values;
use crate::agent_loop_runtime_protocol::{AgentRuntimeEventEnvelope, AgentTimelinePatch};
use crate::worker_agent_runtime::NativeAgentTraceSink;
use crate::worker_protocol::WorkerRequest;
use crate::worker_request_id::next_worker_request_correlation;
use crate::worker_rollout::should_persist_agent_runtime_event;
use crate::{call_rust_state_service, tauri_safe_event_name};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
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
        self.append_trace_events(session_id, run_id, std::slice::from_ref(event))
    }

    fn append_trace_events(
        &self,
        session_id: &str,
        run_id: &str,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), String> {
        let first_event = events.first().ok_or_else(|| {
            "native agent trace batch must contain at least one event".to_string()
        })?;
        let generated = next_worker_request_correlation();
        let request_id = first_event
            .trace_context
            .as_ref()
            .map(|trace| format!("{}:trace-batch:{}", trace.request_id, first_event.event_id))
            .unwrap_or_else(|| generated.id("agent-run-append-trace-batch"));
        let trace_id = first_event
            .trace_context
            .as_ref()
            .map(|trace| trace.trace_id.clone())
            .unwrap_or_else(|| generated.trace_id("agent-run-append-trace-batch"));
        let events = serde_json::to_value(events)
            .map_err(|error| format!("native agent trace batch serialization failed: {error}"))?;
        let events = native_agent_canonical_trace_values(
            events
                .as_array()
                .expect("serialized native agent trace batch must be an array"),
        );
        if events.is_empty() {
            return Ok(());
        }
        let events = serde_json::Value::Array(events);
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("persistence.batch.started");
        let started_at = Instant::now();
        let result = call_rust_state_service(
            self.workspace_root.clone(),
            self.config_snapshot.clone(),
            WorkerRequest::new(
                request_id,
                trace_id,
                "agent_run.append_trace_batch",
                serde_json::json!({
                    "session_id": session_id,
                    "run_id": run_id,
                    "events": events,
                }),
            ),
            "native agent run trace batch append",
        );
        metrics.record_duration("persistence.batch.durationMs", started_at.elapsed());
        metrics.increment_by(
            "persistence.events.written",
            events.as_array().map_or(0, Vec::len) as u64,
        );
        metrics.increment(if result.is_ok() {
            "persistence.batch.completed"
        } else {
            "persistence.batch.failed"
        });
        result.map(|_| ())
    }
}

const TRACE_PERSISTENCE_QUEUE_CAPACITY: usize = 2_048;
const TRACE_PERSISTENCE_BATCH_SIZE: usize = 64;
const TRACE_PERSISTENCE_BATCH_WINDOW: Duration = Duration::from_millis(50);

enum TracePersistenceCommand {
    Append {
        session_id: String,
        run_id: String,
        event: AgentRuntimeEventEnvelope,
    },
    Flush(mpsc::SyncSender<Result<(), String>>),
    Shutdown,
}

struct TracePersistenceWorker {
    sender: mpsc::SyncSender<TracePersistenceCommand>,
    queued_events: Arc<AtomicUsize>,
    join_handle: Mutex<Option<JoinHandle<()>>>,
}

impl Drop for TracePersistenceWorker {
    fn drop(&mut self) {
        let _ = self.sender.send(TracePersistenceCommand::Shutdown);
        if let Some(join_handle) = self
            .join_handle
            .lock()
            .expect("trace persistence worker lock should not be poisoned")
            .take()
        {
            let _ = join_handle.join();
        }
    }
}

#[derive(Clone)]
struct BufferedNativeAgentTraceSink {
    durable_sink: Arc<dyn NativeAgentTraceSink>,
    live_sink: Arc<dyn NativeAgentTraceSink>,
    worker: Arc<TracePersistenceWorker>,
}

#[derive(Clone, Default)]
struct NoopNativeAgentTraceSink;

impl NativeAgentTraceSink for NoopNativeAgentTraceSink {
    fn append_trace_event(
        &self,
        _session_id: &str,
        _run_id: &str,
        _event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        Ok(())
    }
}

impl BufferedNativeAgentTraceSink {
    fn new(
        durable_sink: Arc<dyn NativeAgentTraceSink>,
        live_sink: Arc<dyn NativeAgentTraceSink>,
    ) -> Self {
        let (sender, receiver) = mpsc::sync_channel(TRACE_PERSISTENCE_QUEUE_CAPACITY);
        let queued_events = Arc::new(AtomicUsize::new(0));
        let worker_queued_events = Arc::clone(&queued_events);
        let worker_durable_sink = Arc::clone(&durable_sink);
        let join_handle = std::thread::Builder::new()
            .name("tinybot-trace-persistence".to_string())
            .spawn(move || {
                run_trace_persistence_worker(worker_durable_sink, receiver, worker_queued_events)
            })
            .expect("trace persistence worker should start");
        Self {
            durable_sink,
            live_sink,
            worker: Arc::new(TracePersistenceWorker {
                sender,
                queued_events,
                join_handle: Mutex::new(Some(join_handle)),
            }),
        }
    }

    fn enqueue_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.worker.queued_events.fetch_add(1, Ordering::Relaxed);
        update_persistence_queue_gauge(&self.worker.queued_events);
        let command = TracePersistenceCommand::Append {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            event: event.clone(),
        };
        if self.worker.sender.send(command).is_err() {
            self.worker.queued_events.fetch_sub(1, Ordering::Relaxed);
            update_persistence_queue_gauge(&self.worker.queued_events);
            return Err("trace persistence worker stopped before accepting event".to_string());
        }
        Ok(())
    }
}

impl NativeAgentTraceSink for BufferedNativeAgentTraceSink {
    fn load_runtime_events(
        &self,
        session_id: &str,
        run_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        self.flush()?;
        self.durable_sink.load_runtime_events(session_id, run_id)
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        run_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let live_result = self.live_sink.append_trace_event(session_id, run_id, event);
        if !should_persist_agent_runtime_event(&event.event_name, &event.payload) {
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.events.filtered");
            return live_result;
        }
        let enqueue_result = self.enqueue_event(session_id, run_id, event);
        live_result.and(enqueue_result)?;
        if agent_runtime_event_requires_durable_boundary(event) {
            self.flush()?;
        }
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        session_id: &str,
        run_id: &str,
        patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        self.live_sink
            .append_timeline_patch(session_id, run_id, patch)
    }

    fn flush(&self) -> Result<(), String> {
        let (reply_sender, reply_receiver) = mpsc::sync_channel(0);
        self.worker
            .sender
            .send(TracePersistenceCommand::Flush(reply_sender))
            .map_err(|_| "trace persistence worker stopped before flush".to_string())?;
        reply_receiver
            .recv()
            .map_err(|_| "trace persistence worker stopped during flush".to_string())?
    }
}

fn run_trace_persistence_worker(
    durable_sink: Arc<dyn NativeAgentTraceSink>,
    receiver: mpsc::Receiver<TracePersistenceCommand>,
    queued_events: Arc<AtomicUsize>,
) {
    let mut pending_session_id = String::new();
    let mut pending_run_id = String::new();
    let mut pending_events = Vec::new();
    let mut pending_started_at = None;
    let mut first_error = None;
    loop {
        let command = if pending_events.is_empty() {
            match receiver.recv() {
                Ok(command) => command,
                Err(_) => break,
            }
        } else {
            let remaining = pending_started_at
                .map(|started_at: Instant| {
                    TRACE_PERSISTENCE_BATCH_WINDOW.saturating_sub(started_at.elapsed())
                })
                .unwrap_or(TRACE_PERSISTENCE_BATCH_WINDOW);
            if remaining.is_zero() {
                persist_pending_trace_events(
                    durable_sink.as_ref(),
                    &pending_session_id,
                    &pending_run_id,
                    &mut pending_events,
                    &mut pending_started_at,
                    &queued_events,
                    &mut first_error,
                );
                continue;
            }
            match receiver.recv_timeout(remaining) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_run_id,
                        &mut pending_events,
                        &mut pending_started_at,
                        &queued_events,
                        &mut first_error,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        };
        match command {
            TracePersistenceCommand::Append {
                session_id,
                run_id,
                event,
            } => {
                if !pending_events.is_empty()
                    && (pending_session_id != session_id || pending_run_id != run_id)
                {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_run_id,
                        &mut pending_events,
                        &mut pending_started_at,
                        &queued_events,
                        &mut first_error,
                    );
                }
                if pending_events.is_empty() {
                    pending_session_id = session_id;
                    pending_run_id = run_id;
                    pending_started_at = Some(Instant::now());
                }
                pending_events.push(event);
                if pending_events.len() >= TRACE_PERSISTENCE_BATCH_SIZE {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_run_id,
                        &mut pending_events,
                        &mut pending_started_at,
                        &queued_events,
                        &mut first_error,
                    );
                }
            }
            TracePersistenceCommand::Flush(reply) => {
                persist_pending_trace_events(
                    durable_sink.as_ref(),
                    &pending_session_id,
                    &pending_run_id,
                    &mut pending_events,
                    &mut pending_started_at,
                    &queued_events,
                    &mut first_error,
                );
                let _ = reply.send(first_error.clone().map_or(Ok(()), Err));
            }
            TracePersistenceCommand::Shutdown => {
                persist_pending_trace_events(
                    durable_sink.as_ref(),
                    &pending_session_id,
                    &pending_run_id,
                    &mut pending_events,
                    &mut pending_started_at,
                    &queued_events,
                    &mut first_error,
                );
                break;
            }
        }
    }
}

fn agent_runtime_event_requires_durable_boundary(event: &AgentRuntimeEventEnvelope) -> bool {
    event.event_name == "agent.status"
        && event
            .payload
            .get("isBlocking")
            .and_then(|value| value.as_bool())
            .unwrap_or(true)
}

fn persist_pending_trace_events(
    durable_sink: &dyn NativeAgentTraceSink,
    session_id: &str,
    run_id: &str,
    pending_events: &mut Vec<AgentRuntimeEventEnvelope>,
    pending_started_at: &mut Option<Instant>,
    queued_events: &AtomicUsize,
    first_error: &mut Option<String>,
) {
    if pending_events.is_empty() {
        return;
    }
    let count = pending_events.len();
    let events = std::mem::take(pending_events);
    *pending_started_at = None;
    if let Err(error) = durable_sink.append_trace_events(session_id, run_id, &events) {
        first_error.get_or_insert(error);
    }
    queued_events.fetch_sub(count, Ordering::Relaxed);
    update_persistence_queue_gauge(queued_events);
}

fn update_persistence_queue_gauge(queued_events: &AtomicUsize) {
    crate::runtime::observability::global_agent_runtime_metrics().set_gauge(
        "persistence.queue.depth",
        queued_events.load(Ordering::Relaxed).min(i64::MAX as usize) as i64,
    );
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
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        let started_at = Instant::now();
        let result = self
            .app
            .emit(&event_name, payload)
            .map_err(|error| format!("native agent frontend event emit failed: {error}"));
        metrics.record_duration("live.trace.emit.durationMs", started_at.elapsed());
        metrics.increment(if result.is_ok() {
            "live.trace.emit.completed"
        } else {
            "live.trace.emit.failed"
        });
        result
    }

    fn append_timeline_patch(
        &self,
        _session_id: &str,
        _run_id: &str,
        patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        let started_at = Instant::now();
        let result = self
            .app
            .emit(&tauri_safe_event_name("agent.timeline.patch"), patch)
            .map_err(|error| format!("canonical agent timeline patch emit failed: {error}"));
        metrics.record_duration("live.timeline_patch.emit.durationMs", started_at.elapsed());
        metrics.increment(if result.is_ok() {
            "live.timeline_patch.emit.completed"
        } else {
            "live.timeline_patch.emit.failed"
        });
        result
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
    let live_trace_sink = live_trace_sink.unwrap_or_else(|| Arc::new(NoopNativeAgentTraceSink));
    Arc::new(BufferedNativeAgentTraceSink::new(
        persisted_sink,
        live_trace_sink,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_loop_runtime_protocol::{
        AgentRunEmitter, AgentRuntimeEventAppendInput, AgentRuntimeEventSource,
        AgentRuntimeEventVisibility, AgentRuntimePhase,
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
            _run_id: &str,
            event: &AgentRuntimeEventEnvelope,
        ) -> Result<(), String> {
            self.append_trace_events("", "", std::slice::from_ref(event))
        }

        fn append_trace_events(
            &self,
            _session_id: &str,
            _run_id: &str,
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
        let mut emitter = AgentRunEmitter::new("session-1", "run-1");
        let event = emitter.assistant_delta("unix-ms:1", "hello");

        let started_at = Instant::now();
        sink.append_trace_event("session-1", "run-1", &event)
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
        let mut emitter = AgentRunEmitter::new("session-1", "run-1");
        let first = emitter.assistant_delta("unix-ms:1", "hel");
        let second = emitter.assistant_delta("unix-ms:2", "lo");

        sink.append_trace_event("session-1", "run-1", &first)
            .expect("first event should enqueue");
        sink.append_trace_event("session-1", "run-1", &second)
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
        let mut emitter = AgentRunEmitter::new("session-1", "run-1");
        let first = emitter.tool_start(
            "unix-ms:1",
            "tool-1",
            "workspace.read_file",
            serde_json::json!({ "path": "first.md" }),
        );
        let second = emitter.tool_result(
            "unix-ms:2",
            "tool-1",
            "workspace.read_file",
            serde_json::json!({ "content": "done" }),
        );

        sink.append_trace_event("session-1", "run-1", &first)
            .expect("first event should enqueue");
        sink.append_trace_event("session-1", "run-1", &second)
            .expect("second event should enqueue");
        sink.flush().expect("durable trace should flush");

        assert_eq!(live.event_count(), 2);
        assert_eq!(durable.batch_sizes(), vec![2]);
    }

    #[test]
    fn buffered_trace_sink_persists_only_blocking_status_progress() {
        let durable = Arc::new(RecordingTraceSink::default());
        let live = Arc::new(RecordingTraceSink::default());
        let sink = BufferedNativeAgentTraceSink::new(durable.clone(), live.clone());
        let mut emitter = AgentRunEmitter::new("session-1", "run-1");
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

        sink.append_trace_event("session-1", "run-1", &phase)
            .expect("phase event should remain live");
        sink.append_trace_event("session-1", "run-1", &status)
            .expect("status event should remain live");
        sink.append_trace_event("session-1", "run-1", &blocking_status)
            .expect("blocking status should persist");
        assert_eq!(
            durable.event_count(),
            1,
            "blocking status must cross a durable barrier before append returns"
        );
        sink.flush().expect("trace sink should flush");

        assert_eq!(live.event_count(), 3);
        assert_eq!(durable.event_count(), 1);
    }
}
