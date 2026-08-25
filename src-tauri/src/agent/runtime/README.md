# Native Agent Runtime
<!-- tinybot-module-fingerprint: sha256:b54696822f30701858f286b4438edac45e6a187ebbdfb65e8b3ec435023a8884 -->

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
- Catalog project-local `.agents/skills` alongside enabled Agent Plugin skills,
  injecting full Skill content only for explicit selections.
- Call the configured provider and adapt provider-specific responses.
- Maintain the typed `AgentItem` history used inside the runtime.
- Route model-requested tools through injected dispatch services.
- Expose persistent cross-workspace Thread tools only to eligible project-group
  coordinator Turns.
- Evaluate hooks around provider, turn, thread, and context-compaction stages.
- Emit correlated runtime events and project typed items for compatibility
  consumers.
- Track token usage, cancellation, and resumable form checkpoints. Provider
  cache-read and reasoning-output counts are normalized from both top-level
  usage fields and the Chat Completions/Responses prompt, input, completion,
  or output Token detail objects. Context-window estimates include serialized
  provider-visible tool definitions as well as messages and instructions. Typed
  usage Items keep those normalized context metrics separate from the untouched
  provider payload.

This module does **not** choose the desktop transport, mutate Tauri state, or
decide which durable conversation store a caller uses.

## Execution flow

1. The caller provides `NativeAgentRuntimeServices`, a turn specification, the
   effective configuration, workspace context, and composed instructions.
2. `provider_loop.rs` merges project-local MCP definitions for the effective
   working directory, validates turn settings, and prepares the typed history.
   A standalone manual-compaction turn summarizes older history through the
   same context path, installs its checkpoint, and finishes without a normal
   assistant message.
3. `context.rs`, `context_contributors.rs`, and `instructions.rs` build the
   bounded request context and record provenance/diagnostics.
4. `provider.rs` selects one adapter through `provider_protocol.rs`.
   `chat_completions_adapter.rs` and `responses_adapter.rs` independently encode
   the request and decode provider output into runtime concepts.
5. Assistant items are appended. Tool calls are routed through
   `tool_router.rs`, `tool_dispatcher.rs`, and `tool_runtime.rs`.
6. Tools dispatch directly after validation. Provider-authored argument JSON
   that cannot be prepared blocks dispatch for that batch and produces one
   model-visible error result for every call ID before the provider loop
   continues. Forms use their dedicated resumable mechanism. A tool batch is
   fully recorded before the next provider call.
7. Usage and runtime events are emitted through the injected trace sink, and
   `result.rs` builds the terminal response.

MCP discovery and calls use the effective working directory as their runtime
key and stdio default cwd.

When a Turn does not configure a context-window strategy, the runtime defaults
to `compact`. Explicit `discard` remains supported. Compaction failure is
reported through the typed failure path and never silently falls back to
discarding history.

`context_window_config.rs` resolves the effective window behind one runtime
interface. Turn overrides win over Provider Profile model overrides; known
DeepSeek V4 models then use 1M automatically, while the legacy global value is
retained only as an unknown-model fallback before the 128K default.

Project-group coordinator Turns receive `spawn_workspace_thread` and
`send_thread_message`. Each call authorizes the target workspace against the
group, creates or resumes a normal user-visible persistent Thread, and returns
its terminal status and final message. Child Turns inherit the installed trace
sink so durable projection and live desktop timeline patches stay aligned.
They remain owned by the parent Turn: parent cancellation propagates to active
children and waits for their bounded cleanup before the parent becomes
terminal.

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
use the existing Chat Completions path. Durable `tinyos.image` references keep
only managed local metadata; the Responses adapter validates and Base64-encodes
their files when constructing each request. Chat Completions rejects image
references instead of silently degrading them to path text.

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

Custom OpenAI-compatible providers assume reasoning-effort parameters are
supported unless their profile sets `supportsReasoningEffort: false`. Both
protocol adapters apply that profile decision at the wire boundary: Chat
Completions omits `reasoning_effort`, while Responses omits only
`reasoning.effort`. Reasoning summary settings retain their separate
capability check and wire field.

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
- `items.rs`, `item_event_projection.rs`, `subagent_projection.rs`: canonical
  items and compatibility projections.
- `context.rs`, `context_manager.rs`, `context_contributors.rs`,
  `context_window_config.rs`,
  `instructions.rs`, `usage.rs`: model-visible context, compaction, usage, and
  instruction composition.
- `tool_router.rs`, `tool_dispatcher.rs`, `tool_runtime.rs`: discovery,
  routing, execution, cleanup, and deferred tools.
- `workspace_threads.rs`: project-group authorization, persistent child Thread
  execution, follow-up messages, and parent cancellation propagation.
- `tool_projection.rs`, `tool_result.rs`: normalized tool lifecycle output.
- `hooks.rs`, `events.rs`, `trace_commit.rs`: runtime hooks, event construction,
  and ordered trace commits.
- `checkpoint.rs`, `continuations.rs`, `stores.rs`: resumable form boundaries
  plus default in-memory services.
- `settings.rs`, `state.rs`, `user_input.rs`, `result.rs`: validated turn state
  and result construction.

## Invariants

- `AgentItem` is the runtime domain history. Legacy message JSON is a boundary
  representation, not the internal source of truth.
- Model-visible additions must be bounded and should retain provenance.
- A turn that is awaiting form input is not terminal.
- Cancellation is cooperative and must be checked at provider and tool
  boundaries; late work must not overwrite a terminal outcome.
- Tool execution goes through the dispatcher so capability, ownership, trace,
  and cleanup behavior remain consistent.
- Every provider tool-call ID receives exactly one model-visible result before
  the next provider request, including calls rejected before dispatch because
  their argument JSON is invalid.
- Model-visible shell results keep one compact process-control view with the
  interleaved output. The full process snapshot is available to live runtime
  projections, but durable response items use that compact view as their sole
  Shell output and checkpoints omit the redundant raw snapshot. Generic tool
  envelopes own their raw result only once.
- Checkpoint top-level fields are the canonical resumable state. The nested
  payload contains only phase-specific data and does not repeat promoted
  iteration, message, pending-call, or completed-result fields.
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

Typed in-process hooks run at provider, turn, thread, tool, and
context-compaction boundaries. A typed hook error, malformed diagnostic, or
invalid decision at an active stage fails the turn. Before-tool hooks run after
registry and capability validation and may replace normalized arguments or
return a model-visible denied result without dispatching the tool.

Trusted user command hooks share the active stages `UserPromptSubmit`,
`BeforeToolUse`, `AfterToolUse`, and `CompactionComplete`, projected as the
Codex-compatible event names `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
and `PostCompact`. They execute asynchronously from Rust, fail open on runner
errors with an observable `agent.hook.decision`, and can add developer context.
Post-tool feedback changes the model-visible observation only; it cannot undo a
completed tool side effect. Command discovery, exact-definition trust, process
limits, and wire shapes are owned by `command_hooks` and the desktop command
reference.

Every runtime event in one Turn shares the same trace context. Provider events
add `providerAttemptId`, tool events retain `itemId` and `toolCallId`, and
internal Worker RPC operations derive request IDs under the same root trace.
Persisted tool envelopes use the configured secret-redaction path.

Special tool results use the shared `tool_outcome` envelope projection instead
of relying on tool-specific prose hidden in raw JSON. The outer envelope status
continues to report whether dispatch completed, while the outcome records the
observed effect, whether an action ran, the reason, retry disposition, and an
optional next tool call. A central projection derives model recovery guidance,
the envelope summary, and UI metadata from those facts. Malformed outcomes fail
projection rather than reaching the model. Ordinary successful results retain
the existing generic projection. Web adapters report navigation and page-state
effects; Shell adapters report retained processes, cancellation, timeout,
non-zero exit, failure, and truncated output; MCP adapters report configuration,
allowlist, transport, and MCP `isError` results through the same projection.

The runtime also guards against equivalent external tool calls that repeat a
no-progress outcome. Tool names and recursively canonicalized arguments are
hashed in memory and are not added to diagnostics. The first no-progress result
reaches the model with replanning guidance; an equivalent call made before a
successful tool declared to mutate workspace or session state is not dispatched
and receives a `repeated_no_progress` outcome instead. Changed arguments and
explicitly recommended same-call continuations remain allowed. Runtime-control
tools such as plan updates, tool search, and user-input requests are outside
this guard.

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

User-authored conversation messages never continue an active Turn. The desktop
"insert" action cancels the active Turn, waits for both native cancellation
confirmation and its interrupted terminal event, then submits the message through
the normal Turn-start path with a new Turn ID. Its complete input envelope,
including the selected model and references, is preserved exactly as it is for a
normal or queued message. Queued messages use the same Turn-start path after the
active Turn completes normally. Once either pending input is successfully
submitted, it is removed from the pending-input queue. Protocol-level guidance
remains reserved for internal controls and is not used as a desktop
conversation-message transport.

Cancellation is idempotent and has one terminal owner. The Turn remains in
`cancelling` while owned children perform bounded cleanup, and a late result
cannot replace the published terminal result. Workspace child Threads follow
this same ownership contract instead of detaching when their coordinator stops.

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

Each tool call runs under an owned task and child cancellation token. Calls
marked parallel-safe by registry policy share a wave; exclusive calls split the
batch into sequential waves. Every wave is awaited and results are projected in
model order before the next provider call. Rejected batches also project one
terminal result per provider call ID. If any call has malformed or non-object
argument JSON, the whole batch is rejected without side effects: the malformed
call keeps its parser error and every otherwise-valid call receives a batch
rejection result so protocol call/result pairing remains complete. Tool cleanup
comes from the registry policy:

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

## Backend-selected tools, plans, and forms

The foundational model-visible tool set contains available instances of
`exec_command`, `write_stdin`, `apply_patch`, `request_user_input`,
`update_plan`, `publish_data_view`, `web.open`, `web.read`, `web.act`, and the
`subagent.spawn`, `subagent.send_input`, `subagent.wait`, `subagent.close`, and
`subagent.resume` lifecycle controls. MCP tools explicitly allowlisted by backend
workspace configuration are injected after discovery. Eligible project-group
coordinator Turns additionally receive `spawn_workspace_thread` and
`send_thread_message`; ordinary Threads never see them. Other deferred
extension tools remain hidden unless selected by backend Turn policy. Selection
lasts only for the current Turn; inactive calls fail before dispatch.

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

For frontend-visible shapes and event names, see the
[Agent runtime API](../../../../docs/api/agent-runtime.md) and
[Tauri event reference](../../../../docs/api/events.md).
