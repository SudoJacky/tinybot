# Native Agent Runtime

`agent::runtime` implements Tinybot's native model-and-tool execution
loop. It turns a validated turn specification, runtime services, and composed
instructions into typed agent items, runtime events, checkpoints, usage, and a
terminal result.

The module is independent of the Tauri command surface. Desktop integration,
history selection, attachment lifetime, and durable turn orchestration belong
to [`agent::bridge`](../bridge/README.md).

## Responsibilities

- Normalize turn settings, input history, and context-window behavior.
- Compose bounded context contributions and instruction provenance.
- Call the configured provider and adapt provider-specific responses.
- Maintain the typed `AgentItem` history used inside the runtime.
- Route model-requested tools through injected dispatch services.
- Evaluate hooks around provider, tool, turn, and context stages.
- Emit correlated runtime events and project typed items for compatibility
  consumers.
- Track token usage, cancellation, pause/resume continuations, and resumable
  form checkpoints.

This module does **not** choose the desktop transport, mutate Tauri state, or
decide which durable conversation store a caller uses.

## Execution flow

1. The caller provides `NativeAgentRuntimeServices`, a turn specification, the
   effective configuration, workspace context, and composed instructions.
2. `provider_loop.rs` validates turn settings and prepares the typed history.
3. `context.rs`, `context_contributors.rs`, and `instructions.rs` build the
   bounded request context and record provenance/diagnostics.
4. `provider.rs` selects one adapter through `provider_protocol.rs`.
   `chat_completions_adapter.rs` and `responses_adapter.rs` independently encode
   the request and decode provider output into runtime concepts.
5. Assistant items are appended. Tool calls are routed through
   `tool_router.rs`, `tool_dispatcher.rs`, and `tool_runtime.rs`.
6. Tools dispatch directly after validation. Forms and pause boundaries use
   their dedicated resumable mechanisms. A tool batch is fully recorded before
   the next provider call.
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

Responses API support is opt-in per provider profile. Enable **Use Responses
API** in provider settings, or set `apiMode: "responses"`; otherwise Chat
Completions remains the default. The endpoint must support `/responses`. The
adapter sends `store: false` and replays Tinybot's local message and function
history. It does not use Conversations, `previous_response_id`, hosted tools, or
persist/replay encrypted reasoning items yet. Context compaction continues to
use the existing Chat Completions path.

## Protocol adapter boundary

The runtime owns one protocol-neutral tool registry and one provider/tool loop.
`AgentToolDefinition` contains only the provider-visible name, description, and
input schema. Each adapter converts that definition directly to its own wire
shape; the Responses adapter never consumes or rewrites Chat Completions tool
JSON.

The selected adapter owns all protocol-shaped behavior:

- message and replay-history encoding;
- tool definition encoding;
- request settings and request envelope fields;
- endpoint dispatch and streaming reduction selection;
- assistant text, reasoning, usage, and tool-call decoding;
- tool-result encoding for the following model request;
- provider-native response items used by durable replay.

Reasoning remains provider/replay data and a debug trace concern; it is not a
product-facing canonical timeline item. This keeps Chat Completions and
Responses rendering focused on messages and observable work without exposing
raw chain-of-thought content.

The provider loop, tool router, tool execution, permission checks,
cancellation, tracing, and terminal-result construction remain shared. Adding a
new provider API must extend the adapter router instead of adding API-mode
conditionals throughout those shared runtime modules.

## Internal layout

- `provider_loop.rs`: top-level iteration and stop-condition orchestration.
- `provider.rs`: shared provider invocation and runtime-result construction.
- `provider_protocol.rs`: the single protocol-selection router.
- `chat_completions_adapter.rs`, `responses_adapter.rs`: independent request,
  tool, history, settings, and response adapters.
- `provider_adapter.rs`: protocol-neutral adapter helpers and decoded result
  types.
- `items.rs`, `item_event_projection.rs`: canonical items and compatibility
  projections.
- `context.rs`, `context_contributors.rs`, `instructions.rs`: model-visible
  context and instruction composition.
- `tool_router.rs`, `tool_dispatcher.rs`, `tool_runtime.rs`: discovery,
  routing, execution, cleanup, and deferred tools.
- `tool_projection.rs`, `tool_result.rs`: normalized tool lifecycle output.
- `hooks.rs`, `events.rs`: runtime hooks and event construction.
- `checkpoint.rs`, `continuations.rs`, `stores.rs`: resumable form and pause
  boundaries plus default in-memory services.
- `settings.rs`, `state.rs`, `usage.rs`, `user_input.rs`, `result.rs`: validated
  turn state and result construction.

## Invariants

- `AgentItem` is the runtime domain history. Legacy message JSON is a boundary
  representation, not the internal source of truth.
- Model-visible additions must be bounded and should retain provenance.
- A turn that is awaiting form input or resume is not terminal.
- Cancellation is cooperative and must be checked at provider and tool
  boundaries; late work must not overwrite a terminal outcome.
- Tool execution goes through the dispatcher so capability, ownership, trace,
  and cleanup behavior remain consistent.
- Runtime events for one turn retain the same trace context and stable identity
  fields across provider, tool, checkpoint, and terminal stages.
- Errors should preserve the failing stage; do not convert provider, tool, or
  trace failures into an apparently successful assistant result.

## Contributors, hooks, and observability

Native tools are assembled through ordered `ToolContributor` registrations.
Built-in workspace tools and generic MCP dispatch have named contributors, and
each discovered MCP server contributes its validated dynamic tools. Duplicate
contributor IDs, tool IDs, or methods fail registry construction.

`AgentContextContributor` values run after continuation restoration and before
the first provider request. Their JSON evidence is appended after composed
instructions and never receives instruction precedence. Contributor diagnostics
contain hashes, counts, truncation state, and allowlisted identifiers rather
than prompt text, contribution content, document names, or filesystem paths.
Long-term memory is an instruction source and does not use this extension point.

Hooks run at provider, turn, thread, and context-compaction boundaries. A hook
error, malformed diagnostic, or decision at an inactive stage fails the turn;
tool and permission hooks are not evaluated because those calls dispatch after
registry and capability validation.

Every runtime event in one Turn shares the same trace context. Provider events
add `providerAttemptId`, tool events retain `itemId` and `toolCallId`, and
internal Worker RPC operations derive request IDs under the same root trace.
Persisted tool envelopes use the configured secret-redaction path.

`runtime.metrics` exposes bounded process-local counters, duration aggregates,
and gauges for turns, providers, tools, persistence, cancellation, MCP,
processes, recovery, and memory. Metric names come from fixed runtime enums.
Prompts, tool output, secrets, server names, process IDs, Turn IDs, and trace IDs
are never metric keys or labels.

## Task ownership and shutdown

Every native Turn attempt registers one in-process owner before instruction
loading, provider execution, or tool dispatch. The owner records generation,
phase, cancellation, waiting checkpoint, terminal result, and ignored late
work. Duplicate active Turn IDs are rejected. A form continuation starts a new
generation only after the previous execution reaches a non-terminal waiting
state.

Cancellation is idempotent and has one terminal owner. The Turn remains in
`cancelling` while owned children perform bounded cleanup, and a late result
cannot replace the published terminal result.

Shutdown stops admission, cancels and drains owned Turns, terminates retained
shell process trees, stops MCP clients and stdio children, interrupts
non-terminal subagents, and stops background work. Each bounded cleanup stage
continues after an earlier failure. Combined failures remain visible in the
shutdown report, lifecycle diagnostics, `last_error`, and persistent backend
log. A same-process restart reopens admission only after cleanup completes.

## Provider and tool execution

The desktop bridge, compaction path, provider loop, and OpenAI-compatible
provider are asynchronous end to end. Stream chunks reduce directly into
runtime state. Cancellation is checked before opening a request, between
chunks, and around observer callbacks; after cancellation, late deltas and
provider results are ignored.

Provider failures do not retry automatically. Their terminal reasons distinguish
request timeout, stream-idle timeout, transport failure, provider failure, and
cancellation.

Each tool call runs under an owned task and child cancellation token. Read-only
work may run in parallel, workspace-mutating work is exclusive, and results are
projected in model order. Tool cleanup comes from the registry policy:

- `cooperative`: notify and wait through the cleanup bound;
- `terminate_process`: terminate the owned process after cancellation;
- `detach_forbidden`: require cleanup completion before reporting clean
  cancellation.

Built-in cooperative tools default to a 100 ms cleanup bound; process-owning
and detach-forbidden tools default to 2 seconds. Tool cleanup timeout produces
`tool_cleanup_timeout` and `agent.tool.cleanup_timeout`. A Turn that cannot
complete cooperative cleanup within five seconds produces
`cancellation_cleanup_timeout` and `agent.cleanup_timeout`. Side effects that
finish during cleanup are recorded before the Turn becomes cancelled.

## Deferred tools, plans, and forms

The foundational tool set contains available instances of `exec_command`,
`write_stdin`, `apply_patch`, `request_user_input`, `update_plan`, and
`tool_search`. Browser, subagent, and MCP tools remain deferred until selected
or activated through `tool_search`. Activation lasts only for the current Turn;
inactive calls fail before dispatch.

`update_plan` replaces the complete Turn plan. States are `pending`,
`in_progress`, and `completed`; an incomplete plan has exactly one active step.
Valid updates revise one `<turnId>:plan` timeline item and emit
`agent.plan.progress`.

Resumable form checkpoints persist the activated tool set. Continuation
revalidates it against the current registry and capability policy. Stale IDs,
malformed arrays, or provider-name collisions fail explicitly.

`request_user_input` accepts strict fields of type `text`, `textarea`, `number`,
`select`, `multiselect`, `radio`, or `checkbox`. It persists an
`awaiting_form` checkpoint and emits `agent.awaiting_form`. Submission becomes
the real tool observation and resumes the same provider chain; cancellation
clears the checkpoint and returns `form_cancelled`.

For frontend-visible shapes and event names, see
[the Rust backend API reference](../../../../docs/api/rust-backend-api.md).
