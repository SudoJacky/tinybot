use crate::agent::runtime::NativeAgentTraceSink;
use crate::agent::runtime_protocol::{
    resolve_event_name, AgentEventKind, AgentRuntimeEventEnvelope, AgentTimelinePatch,
    EventNameResolution,
};
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
        let event_count = events.as_array().map_or(0, Vec::len) as u64;
        if result.is_ok() {
            metrics.increment_by("persistence.events.written", event_count);
        } else {
            metrics.increment_by("persistence.events.failed", event_count);
        }
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
    Shutdown(mpsc::SyncSender<Result<(), String>>),
}

struct TracePersistenceWorker {
    sender: mpsc::SyncSender<TracePersistenceCommand>,
    queued_events: Arc<AtomicUsize>,
    queue_high_watermark: Arc<AtomicUsize>,
    terminal_error: Arc<Mutex<Option<String>>>,
    join_handle: Mutex<Option<JoinHandle<()>>>,
}

impl TracePersistenceWorker {
    fn terminal_result(&self) -> Result<(), String> {
        self.terminal_error
            .lock()
            .expect("trace persistence terminal error lock should not be poisoned")
            .clone()
            .map_or(Ok(()), Err)
    }

    fn shutdown(&self) -> Result<(), String> {
        let mut join_handle = self
            .join_handle
            .lock()
            .expect("trace persistence worker lock should not be poisoned");
        let Some(worker_thread) = join_handle.take() else {
            return self.terminal_result();
        };
        let (reply_sender, reply_receiver) = mpsc::sync_channel(0);
        let worker_result = self
            .sender
            .send(TracePersistenceCommand::Shutdown(reply_sender))
            .map_err(|_| "trace persistence worker stopped before shutdown".to_string())
            .and_then(|_| {
                reply_receiver
                    .recv()
                    .map_err(|_| "trace persistence worker stopped during shutdown".to_string())?
            });
        let join_result = worker_thread
            .join()
            .map_err(|_| "trace persistence worker panicked during shutdown".to_string());
        worker_result.and(join_result)
    }
}

impl Drop for TracePersistenceWorker {
    fn drop(&mut self) {
        if self
            .join_handle
            .lock()
            .expect("trace persistence worker lock should not be poisoned")
            .is_none()
        {
            return;
        }
        if let Err(error) = self.shutdown() {
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.worker.shutdown.failed");
            eprintln!("trace persistence worker shutdown failed: {error}");
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
        let queue_high_watermark = Arc::new(AtomicUsize::new(0));
        let terminal_error = Arc::new(Mutex::new(None));
        let worker_queued_events = Arc::clone(&queued_events);
        let worker_terminal_error = Arc::clone(&terminal_error);
        let worker_durable_sink = Arc::clone(&durable_sink);
        let join_handle = std::thread::Builder::new()
            .name("tinybot-trace-persistence".to_string())
            .spawn(move || {
                run_trace_persistence_worker(
                    worker_durable_sink,
                    receiver,
                    worker_queued_events,
                    worker_terminal_error,
                )
            })
            .expect("trace persistence worker should start");
        crate::runtime::observability::global_agent_runtime_metrics().set_gauge(
            "persistence.queue.capacity",
            TRACE_PERSISTENCE_QUEUE_CAPACITY as i64,
        );
        Self {
            durable_sink,
            live_sink,
            worker: Arc::new(TracePersistenceWorker {
                sender,
                queued_events,
                queue_high_watermark,
                terminal_error,
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
        self.worker.terminal_result()?;
        let depth = self.worker.queued_events.fetch_add(1, Ordering::Relaxed) + 1;
        update_persistence_queue_gauges(
            &self.worker.queued_events,
            &self.worker.queue_high_watermark,
            depth,
        );
        let command = TracePersistenceCommand::Append {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            event: event.clone(),
        };
        let enqueue_started_at = Instant::now();
        if self.worker.sender.send(command).is_err() {
            self.worker.queued_events.fetch_sub(1, Ordering::Relaxed);
            update_persistence_queue_gauge(&self.worker.queued_events);
            return Err("trace persistence worker stopped before accepting event".to_string());
        }
        crate::runtime::observability::global_agent_runtime_metrics().record_duration(
            "persistence.queue.backpressure.durationMs",
            enqueue_started_at.elapsed(),
        );
        Ok(())
    }

    #[cfg(test)]
    fn shutdown(&self) -> Result<(), String> {
        self.worker.shutdown()
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
        self.worker.terminal_result()?;
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
        self.worker.terminal_result()?;
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
    terminal_error: Arc<Mutex<Option<String>>>,
) {
    let mut pending_session_id = String::new();
    let mut pending_turn_id = String::new();
    let mut pending_events = Vec::new();
    let mut pending_started_at = None;
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
                    &terminal_error,
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
                        &terminal_error,
                    );
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    persist_pending_trace_events(
                        durable_sink.as_ref(),
                        &pending_session_id,
                        &pending_turn_id,
                        &mut pending_events,
                        &mut pending_started_at,
                        &queued_events,
                        &terminal_error,
                    );
                    break;
                }
            }
        };
        match command {
            TracePersistenceCommand::Append {
                session_id,
                turn_id,
                event,
            } => {
                if trace_persistence_terminal_error(&terminal_error).is_some() {
                    reject_queued_trace_events(&queued_events, 1);
                    continue;
                }
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
                        &terminal_error,
                    );
                }
                if trace_persistence_terminal_error(&terminal_error).is_some() {
                    reject_queued_trace_events(&queued_events, 1);
                    continue;
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
                        &terminal_error,
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
                    &terminal_error,
                );
                send_trace_worker_reply(
                    reply,
                    trace_persistence_terminal_result(&terminal_error),
                    "flush",
                );
            }
            TracePersistenceCommand::Shutdown(reply) => {
                persist_pending_trace_events(
                    durable_sink.as_ref(),
                    &pending_session_id,
                    &pending_turn_id,
                    &mut pending_events,
                    &mut pending_started_at,
                    &queued_events,
                    &terminal_error,
                );
                send_trace_worker_reply(
                    reply,
                    trace_persistence_terminal_result(&terminal_error),
                    "shutdown",
                );
                break;
            }
        }
    }
}

fn agent_runtime_event_requires_durable_boundary(event: &AgentRuntimeEventEnvelope) -> bool {
    match resolve_event_name(&event.event_name) {
        EventNameResolution::Canonical(kind) => matches!(
            kind,
            AgentEventKind::ToolCallDelta
                | AgentEventKind::ToolResult
                | AgentEventKind::TokenCount
                | AgentEventKind::Error
                | AgentEventKind::Cancelled
        ),
        EventNameResolution::DeprecatedIgnored(_) => false,
        EventNameResolution::Unknown => {
            panic!("unknown canonical runtime event `{}`", event.event_name)
        }
    }
}

fn persist_pending_trace_events(
    durable_sink: &dyn NativeAgentTraceSink,
    session_id: &str,
    turn_id: &str,
    pending_events: &mut Vec<AgentRuntimeEventEnvelope>,
    pending_started_at: &mut Option<Instant>,
    queued_events: &AtomicUsize,
    terminal_error: &Mutex<Option<String>>,
) {
    if pending_events.is_empty() {
        return;
    }
    let count = pending_events.len();
    let events = std::mem::take(pending_events);
    *pending_started_at = None;
    if trace_persistence_terminal_error(terminal_error).is_some() {
        crate::runtime::observability::global_agent_runtime_metrics()
            .increment_by("persistence.events.lost", count as u64);
    } else if let Err(error) = durable_sink.append_trace_events(session_id, turn_id, &events) {
        let first_event = events.first();
        let last_event = events.last();
        let mut terminal = terminal_error
            .lock()
            .expect("trace persistence terminal error lock should not be poisoned");
        if terminal.is_none() {
            eprintln!(
                "trace persistence entered terminal failure: {}",
                serde_json::json!({
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "batchSize": count,
                    "firstEventId": first_event.map(|event| event.event_id.as_str()),
                    "firstSequence": first_event.map(|event| event.sequence),
                    "lastEventId": last_event.map(|event| event.event_id.as_str()),
                    "lastSequence": last_event.map(|event| event.sequence),
                    "queueDepth": queued_events.load(Ordering::Relaxed),
                    "error": error,
                })
            );
            crate::runtime::observability::global_agent_runtime_metrics()
                .increment("persistence.worker.terminal_failure");
            *terminal = Some(error);
        }
        crate::runtime::observability::global_agent_runtime_metrics()
            .increment_by("persistence.events.lost", count as u64);
    }
    queued_events.fetch_sub(count, Ordering::Relaxed);
    update_persistence_queue_gauge(queued_events);
}

fn reject_queued_trace_events(queued_events: &AtomicUsize, count: usize) {
    queued_events.fetch_sub(count, Ordering::Relaxed);
    update_persistence_queue_gauge(queued_events);
    crate::runtime::observability::global_agent_runtime_metrics()
        .increment_by("persistence.events.rejected", count as u64);
}

fn trace_persistence_terminal_error(terminal_error: &Mutex<Option<String>>) -> Option<String> {
    terminal_error
        .lock()
        .expect("trace persistence terminal error lock should not be poisoned")
        .clone()
}

fn trace_persistence_terminal_result(terminal_error: &Mutex<Option<String>>) -> Result<(), String> {
    trace_persistence_terminal_error(terminal_error).map_or(Ok(()), Err)
}

fn send_trace_worker_reply(
    reply: mpsc::SyncSender<Result<(), String>>,
    result: Result<(), String>,
    operation: &str,
) {
    if reply.send(result).is_err() {
        crate::runtime::observability::global_agent_runtime_metrics()
            .increment("persistence.worker.reply.failed");
        eprintln!("trace persistence worker {operation} reply receiver was dropped");
    }
}

fn update_persistence_queue_gauges(
    queued_events: &AtomicUsize,
    high_watermark: &AtomicUsize,
    depth: usize,
) {
    high_watermark.fetch_max(depth, Ordering::Relaxed);
    update_persistence_queue_gauge(queued_events);
    crate::runtime::observability::global_agent_runtime_metrics().set_gauge(
        "persistence.queue.high_watermark",
        high_watermark
            .load(Ordering::Relaxed)
            .min(i64::MAX as usize) as i64,
    );
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
