# Native Agent Bridge

`native_agent_bridge` is the application-service layer around the generic
native agent runtime. It coordinates the resources required for a complete
desktop or Thread-owned run without moving those concerns into the provider
loop.

## Responsibilities

- Hydrate runtime history from the appropriate persistence surface.
- Compose instructions using the effective workspace configuration.
- Reject invalid re-entry into an already terminal run.
- Build tool-dispatch and trace-sink services for the run owner.
- Persist run start, runtime trace, checkpoints, and terminal turn state.
- Project runtime results into session- and Thread-compatible response shapes.
- Continue runs after approvals, forms, or additional Thread input.

The bridge does **not** implement provider iteration or define the canonical
Thread data model. Those belong to `worker_agent_runtime` and `worker_thread`.

## Run flow

`agent_flow::run_agent_with_services` is the main orchestration path:

1. Ensure the run has a trace context and reject terminal re-entry.
2. Compose instructions and attach their diagnostics to the persisted spec.
3. Hydrate the runtime history.
4. Persist the run start before provider work begins.
5. Build tool and trace services, selecting the Thread-owned or direct-session
   trace path.
6. Run the native agent loop and flush the trace sink.
7. Persist the run metadata, checkpoint, and final turn boundary as applicable.

Changing this order requires care. In particular, a run must be recoverable
after its start is visible, and trace flushing must not be reported as success
when it failed.

## Internal layout

- `agent_flow.rs`: complete run orchestration.
- `thread_flow.rs`: submit/continue turns and resolve Thread approvals/forms.
- `history.rs`: select and normalize persisted history for the runtime.
- `persistence.rs`: run/checkpoint/turn persistence and cancellation/restore.
- `trace_sink.rs`: live desktop and durable trace sinks.
- `tool_dispatcher.rs`: construct runtime services backed by registered tools.
- `result_projection.rs`: stable result, usage, artifact, and status accessors.
- `webui_continuation.rs`: compatibility continuations for WebUI callers.

## Invariants

- Persist run start before starting provider work.
- Do not execute a terminal run again under the same durable identity.
- Flush trace output before final persistence reports success.
- Keep Thread-owned events on the Thread path; avoid duplicating them through
  the direct-session trace sink.
- Send lossless runtime events to the canonical persistence boundary. Bound or
  redact only the diagnostic EventMsg after its model-visible ResponseItem has
  been materialized.
- Persist each completed assistant message and model-call reasoning item once.
  Final turn persistence closes the Turn and clears checkpoints; it does not
  append the same user or assistant messages again.
- Approval and form resolution must preserve run, turn, request, and trace
  correlation.
- Persistence errors remain visible to callers; a partial durable write is not
  a successful run.

See [`worker_agent_runtime`](../worker_agent_runtime/README.md) for the execution
core and [`worker_thread`](../worker_thread/README.md) for typed conversation
state.
