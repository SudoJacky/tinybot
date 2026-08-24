# Agent Turn Lifecycle
<!-- tinybot-doc-watch:
src-tauri/src/agent/bridge/README.md
src-tauri/src/agent/bridge/agent_flow.rs
src-tauri/src/agent/bridge/thread_flow.rs
src-tauri/src/agent/runtime/README.md
src-tauri/src/agent/runtime/provider_loop.rs
src-tauri/src/agent/runtime/tool_runtime.rs
src-tauri/src/agent/runtime_protocol/README.md
src-tauri/src/runtime/README.md
src-tauri/src/threads/domain/README.md
src-tauri/src/threads/rollout/store/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:e2514dac7954ba67ed72463d6f24ada8be7f05e3d42521a562d3a95019d2ad3a -->

A Turn begins with one user request and contains all provider iterations,
reasoning records, tool calls, tool results, form checkpoints, and the terminal
outcome that follow. Resolving a form continues the same Turn identity.

## Ownership

- `threads::domain` owns typed Thread, Turn, and Item semantics.
- `agent::bridge` owns complete desktop and Thread-backed Turn orchestration.
- `agent::runtime` owns the provider-and-tool execution loop.
- `TurnExecutionRuntime` owns the current live generation, cancellation, and
  terminal-result publication for a Turn ID.
- `threads::rollout::store` owns canonical durability and reconstruction.

## Execution flow

```text
User submission
    |
    v
React command -> native adapter -> Tauri command
    |
    v
Thread target and Turn identity validation
    |
    v
agent::bridge
    |-- hydrate the fixed Thread memory snapshot and compose instructions
    |-- persist Turn start
    |-- hydrate canonical history
    |-- install tool, checkpoint, trace, and trusted command-hook adapters
    v
agent::runtime
    |-- evaluate UserPromptSubmit before the first provider request
    |-- build bounded model context
    |-- call provider
    |-- append assistant items
    |-- evaluate PreToolUse, dispatch, then evaluate PostToolUse
    |-- evaluate PostCompact after installing compacted history
    |-- repeat until form wait, failure, cancellation, or completion
    v
flush trace -> persist terminal state or checkpoint
    |
    v
Rollout reconstruction and live timeline events -> React projection
```

The bridge persists the Turn start before provider work. This ordering makes a
visible Turn recoverable after interruption. Trace output is flushed before a
successful terminal result is persisted.

## Runtime loop

For each provider iteration, the runtime:

1. Restores any continuation and prepares typed `AgentItem` history.
2. Builds the bounded request context and records provenance.
3. Invokes the configured provider adapter.
4. Decodes assistant text, reasoning metadata, usage, and tool calls.
5. Records the complete tool batch before the next provider request.
6. Emits correlated runtime events through the injected trace sink.
7. Stops at a terminal result or creates a resumable checkpoint.

The bridge loads additive global and effective-working-directory command hooks
for each Turn. `UserPromptSubmit` runs after the durable Turn start, so a denied
prompt still produces a recoverable terminal Turn. `PreToolUse` may deny or
replace normalized arguments before dispatch; `PostToolUse` may replace only
the next model-visible observation; `PostCompact` runs after replacement
history and its checkpoint have been installed. Hook-added developer context
is ordered after the associated tool result before another provider request.
Typed in-process hook failures fail the Turn, while command-runner failures are
recorded in `agent.hook.decision` and fail open unless the event returns a
supported explicit blocking decision.

Provider protocols adapt at one seam. Chat Completions and Responses encode
different wire formats but share the same provider/tool loop, permission
checks, cancellation, trace, and result construction.

## Continuation and cancellation

- A Turn awaiting typed form input is waiting, not terminal.
- Checkpoints contain the canonical resumable runtime state and correlation
  identities.
- Continuation must preserve Thread, Turn, request, trace, and pending-call
  identity.
- Cancellation is cooperative at provider and tool seams. A replaced
  generation may drain, but its late result cannot become the current terminal
  result.
- A terminal Turn cannot be executed again under the same durable identity.

## Live and durable projection

Runtime events drive live desktop updates and canonical persistence. Live
presentation may use bounded diagnostics, but model-visible messages, tool
calls, and tool results are materialized before diagnostic truncation. Reloaded
timeline state is reconstructed from the Rollout rather than from renderer
state. Legacy response records without an explicit Item ID derive one from the
Thread, Turn, and sequence so Turn-local sequence reuse remains distinct.

Startup recovery shares one Rollout-head-keyed cache of source lines and
canonical reconstruction across index, Thread projection, and persisted Turn
classification. A changed Rollout head forces the next consumer to read and
reconstruct the updated log before recovery decisions are made.

## Invariants

- Preserve Thread, Turn, Item, tool-call, request, trace, and client-event IDs
  across seams.
- Persist Turn start before provider work and flush trace before terminal
  success.
- Do not append the same user, assistant, or tool item again during terminal
  persistence.
- Keep provider failures, tool failures, trace failures, cancellation, and
  typed waiting states distinguishable.
- Keep trusted command-hook decisions correlated to the same Turn without
  persisting command text, raw stdout, or stderr in diagnostic events; an
  explicit bounded `systemMessage` remains intentional user-facing output.
- Do not create another durable Run identity for a Turn.

## Source modules and verification

- [Agent bridge](../../src-tauri/src/agent/bridge/README.md)
- [Agent runtime](../../src-tauri/src/agent/runtime/README.md)
- [Runtime protocol](../../src-tauri/src/agent/runtime_protocol/README.md)
- [Live runtime services](../../src-tauri/src/runtime/README.md)
- [Agent runtime tests](../../src-tauri/src/agent/runtime/tests/README.md)
- [Agent runtime API](../api/agent-runtime.md)
