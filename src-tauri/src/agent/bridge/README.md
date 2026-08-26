# Native Agent Bridge
<!-- tinybot-module-fingerprint: sha256:3b7ad0ad3084c62cb17437008bfde50a53efe1b7113af6cdd01f3c812e6d8802 -->

`agent::bridge` is the application-service layer around the generic
native agent runtime. It coordinates the resources required for a complete
desktop or Thread-owned turn without moving those concerns into the provider
loop.

## Responsibilities

- Hydrate runtime history from the appropriate persistence surface.
- Compose instructions using the effective workspace configuration.
- Merge project-local MCP definitions for the effective working directory.
- Execute bound Agent Graph tools through the Graph Run service and project
  their final output into the parent Turn.
- Reject invalid re-entry into an already terminal turn.
- Build tool-dispatch and trace-sink services for the turn owner.
- Persist turn start, runtime trace, checkpoints, and terminal turn state.
- Project runtime results into session- and Thread-compatible response shapes.
- Continue turns after forms or additional Thread input.

The bridge does **not** implement provider iteration or define the canonical
Thread data model. Those belong to `agent::runtime` and `threads::domain`.

## Turn flow

`agent_flow::run_agent_with_services` is the main orchestration path:

1. Ensure the turn has a trace context and reject terminal re-entry.
2. Hydrate the Thread's fixed memory snapshot, compose instructions, merge the
   working directory's project-local MCP definitions, and attach instruction
   diagnostics to the persisted spec.
3. Persist the turn start before history loading or provider work begins.
4. Hydrate the runtime history from the canonical Thread projection.
5. Build tool, context-checkpoint, trace, and workspace command-hook services,
   selecting the Thread-owned or direct-session trace path.
6. Execute the native agent loop and flush the trace sink.
7. Persist the terminal boundary or resumable checkpoint as applicable. If
   runtime execution or trace flush fails, persist a failed terminal with the
   original error before returning it to the caller.
8. Schedule memory extraction only after a completed turn is durably persisted.

The tool dispatcher retains the unmerged base configuration alongside the
parent Turn's services. When a Graph Agent node targets another workspace, its
fresh child Turn performs its own project-local MCP merge instead of inheriting
the parent's workspace-local servers. Parent cancellation is forwarded through
the Graph Run to the active child Turn.

Changing this order requires care. In particular, a turn must be recoverable
after its start is visible, and trace flushing must not be reported as success
when it failed.

## Internal layout

- `agent_flow.rs`: complete turn orchestration.
- `context_checkpoint.rs`: commit durable context-compaction checkpoints.
- `thread_flow.rs`: submit/continue turns, trigger standalone context
  compaction, and resolve Thread forms.
- `history.rs`: select and normalize persisted history for the runtime.
- `persistence.rs`: turn/checkpoint persistence and cancellation/restore.
- `trace_sink.rs`: live desktop and durable trace sinks.
- `tool_dispatcher.rs`: construct runtime services backed by registered tools.
- `result_projection.rs`: stable result, usage, artifact, and status accessors.
- `webui_continuation.rs`: form continuations for WebUI callers.

## Invariants

- Persist turn start before starting provider work.
- Do not execute a terminal turn again under the same durable identity.
- Flush trace output before final persistence reports success.
- Runtime and trace errors must leave a durable failed terminal state rather
  than an active Turn that requires startup recovery.
- Keep Thread-owned events on the Thread path; avoid duplicating them through
  the direct-session trace sink.
- Send lossless runtime events to the canonical persistence boundary. Bound or
  redact only the diagnostic EventMsg after its model-visible ResponseItem has
  been materialized.
- Persist each completed assistant message and model-call reasoning item once.
  Final turn persistence closes the Turn and clears checkpoints; it does not
  append the same user or assistant messages again.
- Form resolution must preserve turn, request, and trace correlation.
- Persistence errors remain visible to callers; a partial durable write is not
  a successful turn.
- Frontend event-emission failures log session, turn, event or item identity,
  and revision without logging the event payload.
- Trace persistence-worker and frontend-emission failures use the desktop
  structured collector under the `trace` stream; only collector failures fall
  back to stderr.

See [`agent::runtime`](../runtime/README.md) for the execution core and
[`threads::domain`](../../threads/domain/README.md) for typed conversation
state.
