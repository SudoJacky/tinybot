# Agent Runtime API
<!-- tinybot-doc-watch:
src-tauri/src/agent/runtime_protocol.rs
src-tauri/src/agent/runtime_protocol/event_catalog.rs
src-tauri/src/agent/runtime_protocol_tests.rs
src-tauri/src/desktop_commands/runtime.rs
src-tauri/src/desktop_commands/runtime_tests.rs
-->
<!-- tinybot-doc-fingerprint: sha256:fc52958f7e26d13d5ecaf33bdea76d2bb93fdf0ca00c3e1cb1911f832bd7f497 -->

This document covers native Agent turn execution and provider-facing behavior.
It is part of the [Rust backend API reference](rust-backend-api.md), which
defines the shared invocation conventions and source-backed freshness policy
for this reference set.

## Agent Runtime

The native renderer enters the Agent Runtime through Thread-owned typed commands:
`worker_submit_thread_turn`, `worker_thread_interrupt`, and `worker_submit_thread_form`.

Workspace-backed agent results include:

- `instructionProvenance`: the effective working directory, a SHA-256 hash of the complete model
  instruction text, and ordered source records. Each source records `kind`, path identifier,
  precedence, scope root, load timestamp, source hash, truncation state, and validation warnings.
- `instructionDiagnostics`: structured warnings derived from the source records.
- `traceContext`: stable `requestId`, `traceId`, `turnId`, optional `threadId`, and optional
  `parentTurnId` values shared by runtime events and durable turn records.
- `turnMetrics`: the turn duration and terminal outcome for the completed invocation.
- `contextContributions`: ordered, content-free diagnostics for enabled context contributors. Each
  record includes `contributorId`, `kind`, `status`, `contentChars`, `contentSha256`,
  `referenceCount`, safe reference identifiers, and `truncated`.

The contributor request surface is reserved for future production contributors. The current desktop
runtime does not register a production contributor, so normal turns emit no `contextContributions`
records unless that integration is added explicitly.

The instruction provenance and instruction diagnostics are stored on the durable agent-turn record, so
`thread_list_turns` and `thread_get_turn_runtime_state` can explain the instruction inputs of
a historical turn without persisting a second write authority.

Contributor assembly, hooks, task ownership, cleanup, and metric internals are documented in
`src-tauri/src/agent/runtime/README.md`. `runtime.metrics` remains available through Worker RPC and
returns process-local `counters`, `durations`, and `gauges` without prompt, tool-output, or secret
content.

### Turn settings and provider capabilities

Each Turn owns an immutable settings snapshot parsed from the Turn specification, metadata, and
agent defaults. It includes model, provider, iteration and streaming limits,
temperature, maximum completion tokens, context-window strategy, reasoning options, service tier, output schema,
working directory, permission profile, selected tools, and parallel-tool policy. Reasoning options are
request-specific: they are read only from the Turn specification or metadata, never from agent defaults.
Invalid values fail request construction rather than being reread differently by later stages.

Optional provider features must be declared explicitly on the selected provider profile:

```json
{
  "providers": {
    "profiles": {
      "fixture-default": {
        "provider": "fixture",
        "capabilities": {
          "serviceTier": true,
          "reasoning": true,
          "structuredOutput": true
        }
      }
    }
  }
}
```

`capabilities` may instead be an array containing `service_tier`, `reasoning`, and/or
`structured_output` (camel-case spellings are also accepted). A requested undeclared feature fails
with the resolved provider ID and missing capability. Built-in profile capabilities fall back to the
provider catalog when the profile omits the field; an explicit profile value overrides that default.
Declared settings map to Chat Completions fields as follows: service tier to `service_tier`, reasoning
effort to `reasoning_effort`, reasoning summary configuration to `reasoning`, and output schemas to
`response_format.type = "json_schema"`. For Responses requests, effort and summary map to
`reasoning.effort` and `reasoning.summary`, while output schemas map to `text.format`.

Turn-level runtime controls are also typed and validated before MCP discovery or provider dispatch:

- `workingDirectory`/`cwd` must resolve to an existing directory. Absolute paths outside the
  workspace are accepted; relative paths are resolved from the workspace root. The composed
  instruction provenance and provider context use that directory, and shell tools inherit it when
  their call does not provide `workingDir`.
- `permissionProfile` accepts `local-worker` or `project-coordinator`. Thread-bound turns derive
  this value from the persisted Thread role; the coordinator profile removes direct workspace read,
  workspace write, and shell capabilities. Unknown profiles fail explicitly.
- `selectedTools` is an optional exact allowlist of tool IDs or methods. Deferred selections activate
  for that turn; unknown, unavailable, or duplicate selections fail. An omitted or empty list keeps
  the normal registry.

### Cancellation response

`worker_thread_interrupt` only targets the current active turn. A supplied `turnId` must match that
turn; a stale ID or a thread without an active turn is rejected. Its response includes the owned
task transition as `taskCancellation`:

```json
{
  "runtime": "rust",
  "turnId": "turn-1",
  "cancelled": true,
  "stopReason": "interrupted",
  "task": {
    "turnId": "turn-1",
    "state": "cancel_requested",
    "reason": "user_requested",
    "activeTaskRemoved": false,
    "cleanupPending": true
  }
}
```

Possible task states are `cancel_requested`, `cancelled_waiting`, `already_terminal`, and
`not_found`. User interruption cancels the provider stream and notifies running tools to clean up.
If cooperative cleanup exceeds its grace period, the owned task is aborted and an
`agent.cleanup_timeout` diagnostic is retained, while the turn still ends as `interrupted`.
Already streamed assistant text is materialized before the terminal boundary so it remains visible
after reload. The durable Rollout boundary is `TurnAborted` with `status`, `phase`, and `stopReason`
set to `interrupted`. Provider-initiated cancellation and runtime shutdown remain `cancelled`.

### Provider failure results

Provider failures do not retry automatically and preserve distinct `stopReason` values:

- `cancelled`
- `provider_request_timeout`
- `provider_stream_idle_timeout`
- `provider_transport_error`
- `provider_error`

Timeout, transport, and provider failures emit `agent.error` with the same `stopReason`. A provider
cancellation follows the normal `agent.cancelled` path.

### Native agent turn specification

When `maxIterations` is omitted from the turn specification, metadata, and agent defaults, the native
runtime uses `200`. Explicit turn or settings values still take precedence.

```json
{
  "turnId": "turn-1",
  "sessionId": "websocket:chat-1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "deepseek-v4-pro",
  "maxIterations": 20,
  "stream": true,
  "developerInstructions": "Use the native runtime for this turn.",
  "selectedSkills": ["review-work"],
  "collaborationMode": "Work as the primary implementation agent.",
  "agentRole": "Own the result through verification.",
  "metadata": {}
}
```

### Backend tool selection and checkpoints

MCP tools explicitly allowlisted by workspace configuration are injected after backend discovery.
Other extension tools may remain deferred until selected explicitly for the current Turn. Core
browser and subagent lifecycle tools are model-visible by default. Calls to inactive deferred tools fail with
`stopReason: "policy_denied"`. Form continuations revalidate the persisted activation set against
the current registry and capability policy.

### Project-coordinator Thread tools

Project groups explicitly list canonical workspace directories and may combine repositories from
unrelated parent directories. A persisted Thread with `source: "project_coordinator"` and
`metadata.extra.projectGroupId` receives two additional model-visible tools:

- `spawn_workspace_thread({ workspaceId, message })` creates a normal persisted child Thread in
  that eligible workspace, records `parentThreadId` and `source: "workspace_thread"`, submits the
  initial content as a normal user message, waits for the Turn to stop, and returns
  `{ threadId, status, finalMessage }`.
- `send_thread_message({ threadId, message })` accepts only a `workspace_thread` created directly
  by the current Thread, submits another normal user message, waits for the Turn to stop, and
  returns the same shape.

Multiple `spawn_workspace_thread` calls from one provider response run concurrently and the
coordinator waits for all of them before its next model call. `send_thread_message` remains
exclusive and is serialized with other waves so messages to an existing child Thread retain a
defined order. Interrupting the coordinator Turn cancels each workspace Turn owned by its active
tool calls, waits for those child Turns to persist an `interrupted` terminal boundary, and leaves
the child Threads available for later user messages.

`status` is one of `completed`, `awaiting_user`, `failed`, or `interrupted`. The result deliberately
does not expose a final-message item ID. Membership is reread from the project-group store for every
Turn and revalidated at execution time; an arbitrary path or unrelated Thread ID is rejected.
Ordinary workspace Threads do not receive these tools. Coordinator Threads also use the
`project-coordinator` permission profile, which removes direct workspace read, workspace write, and
shell capabilities; work in a member repository must pass through a child Thread. Deleting a group
does not delete its Threads, but immediately removes their cross-workspace tool authorization.
Child Threads remain user-visible desktop sessions, unlike the session-internal `subagent.*`
lifecycle. Their Turns inherit the coordinator's live timeline sink, so a newly spawned child is
added to the workspace session list while it is running. Users may open the child timeline and,
after its active Turn stops, continue the conversation through the normal composer.

### Model-requested user input

`request_user_input` creates an `awaiting_form` checkpoint and returns
`stopReason: "awaiting_form"`. `worker_submit_thread_form` must use its matching `threadId` and
`formId`; submitting resumes the same provider chain, while cancellation returns
`stopReason: "form_cancelled"`.
