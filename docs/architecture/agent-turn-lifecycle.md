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
<!-- tinybot-doc-fingerprint: sha256:1311d33dbcec3b94551fd6f2d262e75c309076514e4c8e4fc35cc2ff772412ca -->

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
    |-- merge project-local MCP definitions for the effective working directory
    |-- discover same-workspace Agent Graph tools for ordinary Chat Turns
    |-- persist Turn start
    |-- optionally spawn the independent first-Turn title request
    |-- hydrate canonical history
    |-- install tool, checkpoint, trace, and trusted command-hook adapters
    v
agent::runtime
    |-- evaluate UserPromptSubmit before the first provider request
    |-- build bounded model context
    |-- assemble and estimate the provider-protocol request
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
successful terminal result is persisted. If runtime execution or trace flush
fails, the bridge persists a failed terminal state with `runtime_error` before
returning the original error to the desktop caller; the renderer can then
reload the canonical Rollout instead of leaving the Turn active.

For an empty default-titled Thread, that durable start also gates one detached
title request. It uses the resolved Provider and model but has no tools and does
not enter or block the Agent Loop. Failure is recorded in native diagnostics and
leaves the deterministic first-prompt title in place. A late result is committed
only if its source remains the first user Turn and a manual rename has not taken
ownership; successful persistence emits a metadata-only frontend refresh event.

Project-local MCP configuration is discovered after instruction composition
establishes the effective working directory and before runtime services are
installed. The merged configuration is Turn-local, while MCP discovery publishes
a revisioned immutable registry snapshot shared with the WebUI catalog. Turn
preparation captures one snapshot and builds all concrete MCP schemas from it;
an individual server discovery or schema failure disables only that server and
does not abort the Turn or remove healthy servers. The saved global configuration
remains unchanged.

Saved Agent Graphs are discovered only when the Thread or Turn explicitly
declares a working directory; the backend default is not treated as Graph
scope. They are contributed as deferred tools bound to the canonical
definition workspace, Graph ID, and revision; provider arguments contain only
the Run input. Graph-created Agent node Turns carry Graph Run metadata and skip
this contribution, so Graph execution cannot recursively expose Graph tools.
Cancelling the parent Turn cancels the active Graph Run and child Agent Turn.

After context projection, the runtime encodes one final Chat Completions or
Responses request, estimates its serialized size, and retains that same value
for provider dispatch. Provider-visible expansions therefore cannot diverge
between usage estimation and the request that is sent.

## Runtime loop

For each provider iteration, the runtime:

1. Restores any continuation and prepares typed `AgentItem` history.
2. Builds the bounded request context and records provenance.
3. Encodes and estimates the final provider request, then dispatches that same value.
4. Decodes assistant text, reasoning metadata, optional provider usage, and tool
   calls. Chat Completions and Responses usage pass through one shared mapper,
   including nested cache and reasoning detail counters; missing usage remains
   absent instead of becoming an all-zero provider count.
5. Records the complete tool batch before the next provider request.
6. Converts provider-authored argument preparation failures into correlated
   tool results for every call in the batch, then continues planning without
   dispatching partial side effects.
7. Emits correlated runtime events through the injected trace sink.
8. Stops at a terminal result or creates a resumable checkpoint.

Several calls in one provider response form an ordered batch, not a requirement
to execute them simultaneously. Registry policy marks concurrency-safe calls;
the runtime groups those calls into parallel waves and treats every exclusive
call as an ordering barrier. `update_plan` is such a barrier, so a plan update
may precede ordinary calls in the same response without rejecting the batch.

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
- Entering `awaiting_form` checkpoints the resumable runtime and ends the active
  invocation, so elapsed human response time is not treated as a tool timeout.
- Checkpoints contain the canonical resumable runtime state and correlation
  identities.
- Continuation must preserve Thread, Turn, request, trace, and pending-call
  identity.
- A form submit or cancel command is acknowledged with its command identity
  before provider work resumes. Submitted values become the original pending
  tool call's model-visible result in that same provider chain.
- Cancellation is cooperative at provider and tool seams. A replaced
  generation may drain, but its late result cannot become the current terminal
  result.
- A terminal Turn cannot be executed again under the same durable identity.

## Live and durable projection

Runtime events drive live desktop updates and canonical persistence. Live
presentation may use bounded diagnostics, but model-visible messages, tool
calls, and tool results are materialized before diagnostic truncation. Reloaded
timeline state is reconstructed from the Rollout rather than from renderer
state. Textual reasoning deltas revise one live timeline item, and its completed
semantic event is durable even when it flushes before the provider-native
response batch. Reload uses that semantic event for the timeline and retains
the matching native reasoning record only for provider replay. Legacy response
records without an explicit Item ID derive one from the Thread, Turn, and
sequence so Turn-local sequence reuse remains distinct.
Plan-progress events are durable full snapshots. Normal Turn completion leaves
their last reported step states unchanged; failure and interruption still
project unfinished work to the corresponding terminal outcome.

Startup recovery shares one Rollout-head-keyed cache of source lines and
canonical reconstruction across index, Thread projection, and persisted Turn
classification. A changed Rollout head forces the next consumer to read and
reconstruct the updated log before recovery decisions are made.

## Invariants

- Preserve Thread, Turn, Item, tool-call, request, trace, and client-event IDs
  across seams.
- Persist Turn start before provider work and flush trace before terminal
  success; persist a failed terminal before returning a runtime or trace error.
- Keep first-Turn title generation independent from the main Turn and never let
  a late model title replace a manual rename. Reuse the initiating Turn's
  effective Provider request settings while replacing its prompt and omitting
  tools and prior history; do not apply a separate title token budget.
- Do not append the same user, assistant, or tool item again during terminal
  persistence.
- Keep provider failures, tool failures, trace failures, cancellation, and
  typed waiting states distinguishable.
- Preserve one model-visible result for every provider tool-call ID, including
  calls rejected before dispatch because another call in the batch is invalid.
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
