# Native Agent Runtime

`worker_agent_runtime` implements Tinybot's native model-and-tool execution
loop. It turns a validated run specification, runtime services, and composed
instructions into typed agent items, runtime events, checkpoints, usage, and a
terminal result.

The module is independent of the Tauri command surface. Desktop integration,
history selection, attachment lifetime, and durable run orchestration belong
to [`native_agent_bridge`](../native_agent_bridge/README.md).

## Responsibilities

- Normalize run settings, input history, and context-window behavior.
- Compose bounded context contributions and instruction provenance.
- Call the configured provider and adapt provider-specific responses.
- Maintain the typed `AgentItem` history used inside the runtime.
- Route model-requested tools through injected dispatch services.
- Evaluate hooks around provider, tool, permission, turn, and context stages.
- Emit correlated runtime events and project typed items for compatibility
  consumers.
- Track token usage, cancellation, pause/resume continuations, live approval
  waiters, and resumable checkpoints.

This module does **not** choose the desktop transport, mutate Tauri state, or
decide which durable conversation store a caller uses.

## Execution flow

1. The caller provides `NativeAgentRuntimeServices`, a run specification, the
   effective configuration, workspace context, and composed instructions.
2. `provider_loop.rs` validates turn settings and prepares the typed history.
3. `context.rs`, `context_contributors.rs`, and `instructions.rs` build the
   bounded request context and record provenance/diagnostics.
4. `provider.rs` and `provider_adapter.rs` issue the model request and translate
   provider events into runtime concepts.
5. Assistant items are appended. Tool calls are routed through
   `tool_router.rs`, `tool_dispatcher.rs`, and `tool_runtime.rs`.
6. Approval registers an in-memory responder and suspends the original tool
   future. Forms and pause boundaries still use their dedicated resumable
   mechanisms. A tool batch is fully recorded before the next provider call.
7. Usage and runtime events are emitted through the injected trace sink, and
   `result.rs` builds the terminal response.

## Public extension points

The main injected boundaries are:

- `NativeAgentProvider`: model request/stream implementation.
- `NativeAgentToolDispatcher`: tool execution boundary.
- `NativeAgentCheckpointStore`: resumable state storage.
- `NativeAgentCancellation`: external cancellation state.
- `NativeAgentTraceSink`: durable or live runtime-event destination.
- `AgentContextContributor`: bounded additions to model-visible context.
- `AgentHook`: typed policy or observation around runtime stages.

Prefer extending these boundaries over adding transport or persistence
conditionals to the provider loop.

## Internal layout

- `provider_loop.rs`: top-level iteration and stop-condition orchestration.
- `provider.rs`, `provider_adapter.rs`: provider configuration and response
  translation.
- `items.rs`, `item_event_projection.rs`: canonical items and compatibility
  projections.
- `context.rs`, `context_contributors.rs`, `instructions.rs`: model-visible
  context and instruction composition.
- `tool_router.rs`, `tool_dispatcher.rs`, `tool_runtime.rs`: discovery,
  routing, execution, cleanup, and deferred tools.
- `tool_projection.rs`, `tool_result.rs`: normalized tool lifecycle output.
- `hooks.rs`, `events.rs`: runtime hooks and event construction.
- `approvals.rs`: live approval responders and exact per-session grants.
- `checkpoint.rs`, `continuations.rs`, `stores.rs`: other resumable boundaries
  and default in-memory services.
- `settings.rs`, `state.rs`, `usage.rs`, `user_input.rs`, `result.rs`: validated
  turn state and result construction.

## Invariants

- `AgentItem` is the runtime domain history. Legacy message JSON is a boundary
  representation, not the internal source of truth.
- Model-visible additions must be bounded and should retain provenance.
- A run that is awaiting approval, form input, or resume is not terminal.
- Cancellation is cooperative and must be checked at provider and tool
  boundaries; late work must not overwrite a terminal outcome.
- Tool execution goes through the dispatcher so capability, approval,
  ownership, trace, and cleanup behavior remain consistent.
- Runtime events for one run retain the same trace context and stable identity
  fields across provider, tool, checkpoint, and terminal stages.
- Errors should preserve the failing stage; do not convert provider, tool, or
  trace failures into an apparently successful assistant result.

For frontend-visible shapes and event names, see
[the Rust backend API reference](../../../docs/api/rust-backend-api.md).
