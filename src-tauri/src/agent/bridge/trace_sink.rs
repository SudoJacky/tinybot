use crate::agent::runtime::NativeAgentTraceSink;
use crate::agent::runtime_protocol::{AgentRuntimeEventEnvelope, AgentTimelinePatch};
use crate::protocol::request_id::next_worker_request_correlation;
use crate::protocol::WorkerRequest;
use crate::rpc::call_rust_state_service;
use crate::threads::rollout::store::is_turn_semantic_event;
use crate::threads::workspace_store::WorkspaceThreadStore;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime};

fn tauri_safe_event_name(event_name: &str) -> String {
    event_name.replace('.', ":")
}

#[derive(Clone)]
pub(crate) struct AgentTurnSemanticSink {
    thread_store: WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
}

impl AgentTurnSemanticSink {
    pub(crate) fn new(
        thread_store: WorkspaceThreadStore,
        config_snapshot: serde_json::Value,
    ) -> Self {
        Self {
            thread_store,
            config_snapshot,
        }
    }
}

impl NativeAgentTraceSink for AgentTurnSemanticSink {
    fn load_runtime_events(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        let generated = next_worker_request_correlation();
        let value = call_rust_state_service(
            &self.thread_store,
            self.config_snapshot.clone(),
            WorkerRequest::new(
                generated.id("agent-turn-runtime-state"),
                generated.trace_id("agent-turn-runtime-state"),
                "thread.turn.runtime_state",
                serde_json::json!({
                    "threadId": session_id,
                    "turnId": turn_id,
                }),
            ),
            "native agent turn runtime state",
        )?;
        serde_json::from_value(
            value
                .get("runtimeEvents")
                .cloned()
                .ok_or_else(|| "agent turn runtime state is missing runtimeEvents".to_string())?,
        )
        .map_err(|error| format!("invalid persisted runtime events: {error}"))
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.append_trace_events(session_id, turn_id, std::slice::from_ref(event))
    }

    fn append_trace_events(
        &self,
        session_id: &str,
        turn_id: &str,
        events: &[AgentRuntimeEventEnvelope],
    ) -> Result<(), String> {
        let first_event = events.first().ok_or_else(|| {
            "native agent semantic batch must contain at least one event".to_string()
        })?;
        let generated = next_worker_request_correlation();
        let request_id = first_event
            .trace_context
            .as_ref()
            .map(|trace| {
                format!(
                    "{}:semantic-batch:{}",
                    trace.request_id, first_event.event_id
                )
            })
            .unwrap_or_else(|| generated.id("agent-turn-append-semantic-batch"));
        let trace_id = first_event
            .trace_context
            .as_ref()
            .map(|trace| trace.trace_id.clone())
            .unwrap_or_else(|| generated.trace_id("agent-turn-append-semantic-batch"));
        let events = serde_json::to_value(events).map_err(|error| {
            format!("native agent semantic batch serialization failed: {error}")
        })?;
        let metrics = crate::runtime::observability::global_agent_runtime_metrics();
        metrics.increment("persistence.batch.started");
        let started_at = Instant::now();
        let result = call_rust_state_service(
            &self.thread_store,
            self.config_snapshot.clone(),
            WorkerRequest::new(
                request_id,
                trace_id,
                "thread.turn.append_semantic_batch",
                serde_json::json!({
                    "threadId": session_id,
                    "turnId": turn_id,
                    "events": events,
                }),
            ),
            "native agent semantic batch append",
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
        turn_id: String,
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
        _turn_id: &str,
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
        turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        self.worker.queued_events.fetch_add(1, Ordering::Relaxed);
        update_persistence_queue_gauge(&self.worker.queued_events);
        let command = TracePersistenceCommand::Append {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
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
        turn_id: &str,
    ) -> Result<Vec<AgentRuntimeEventEnvelope>, String> {
        self.flush()?;
        self.durable_sink.load_runtime_events(session_id, turn_id)
    }

    fn append_trace_event(
        &self,
        session_id: &str,
        turn_id: &str,
        event: &AgentRuntimeEventEnvelope,
    ) -> Result<(), String> {
        let live_result = self
            .live_sink
            .append_trace_event(session_id, turn_id, event);
        if !is_turn_semantic_event(&event.event_name) {
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.events.filtered");
            return live_result;
        }
        let enqueue_result = self.enqueue_event(session_id, turn_id, event);
        live_result.and(enqueue_result)?;
        if agent_runtime_event_requires_durable_boundary(event) {
            self.flush()?;
        }
        Ok(())
    }

    fn append_timeline_patch(
        &self,
        session_id: &str,
        turn_id: &str,
        patch: &AgentTimelinePatch,
    ) -> Result<(), String> {
        self.live_sink
            .append_timeline_patch(session_id, turn_id, patch)
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
    let mut pending_turn_id = String::new();
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
                    &pending_turn_id,
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
                        &pending_turn_id,
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
                turn_id,
                event,
            } => {
                if !pending_events.is_empty()
                    && (pending_session_id != session_id || pending_turn_id != turn_id)
                {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_turn_id,
                        &mut pending_events,
                        &mut pending_started_at,
                        &queued_events,
                        &mut first_error,
                    );
                }
                if pending_events.is_empty() {
                    pending_session_id = session_id;
                    pending_turn_id = turn_id;
                    pending_started_at = Some(Instant::now());
                }
                pending_events.push(event);
                if pending_events.len() >= TRACE_PERSISTENCE_BATCH_SIZE {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_turn_id,
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
                    &pending_turn_id,
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
                    &pending_turn_id,
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
    matches!(
        event.event_name.as_str(),
        "agent.tool_call.delta"
            | "agent.tool.result"
            | "agent.token_count"
            | "agent.awaiting_approval"
            | "agent.approval.decision"
            | "agent.error"
            | "agent.cancelled"
    )
}

fn persist_pending_trace_events(
    durable_sink: &dyn NativeAgentTraceSink,
    session_id: &str,
    turn_id: &str,
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
    if let Err(error) = durable_sink.append_trace_events(session_id, turn_id, &events) {
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
        _turn_id: &str,
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
        _turn_id: &str,
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
    thread_store: WorkspaceThreadStore,
    config_snapshot: serde_json::Value,
    live_trace_sink: Option<Arc<dyn NativeAgentTraceSink>>,
) -> Arc<dyn NativeAgentTraceSink> {
    let persisted_sink: Arc<dyn NativeAgentTraceSink> =
        Arc::new(AgentTurnSemanticSink::new(thread_store, config_snapshot));
    let live_trace_sink = live_trace_sink.unwrap_or_else(|| Arc::new(NoopNativeAgentTraceSink));
    Arc::new(BufferedNativeAgentTraceSink::new(
        persisted_sink,
        live_trace_sink,
    ))
}

#[cfg(test)]
#[path = "trace_sink_tests.rs"]
mod tests;
