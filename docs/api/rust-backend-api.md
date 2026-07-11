# Rust Backend API Reference

Source snapshot: `c2639409`

This document describes the API surfaces exposed by the Rust/Tauri backend in `src-tauri`.
It is intended for frontend callers and integrators who need command names, invocation
patterns, response envelopes, and the current Rust-owned route inventory.

## Surfaces

The Rust backend is reachable through four surfaces:

1. Tauri commands registered in `src-tauri/src/lib.rs`.
2. `worker_webui_route`, a Tauri command that emulates HTTP/WebUI routes and returns an HTTP-like response envelope.
3. Worker RPC methods handled by `WorkerRpcRouter`.
4. Tauri events emitted for live agent/runtime updates.

Most desktop frontend code should prefer typed wrappers under `src/app-core/native/*`.
Direct `invoke()` calls are still documented here because they are the actual backend contract.

## Tauri Invocation Contract

Use Tauri's `invoke` API:

```ts
import { invoke } from "@tauri-apps/api/core";

const status = await invoke("gateway_status");
const messages = await invoke("worker_session_messages", {
  input: { key: "websocket:chat-1" },
});
```

General rules:

- Commands without an input struct are invoked with no second argument.
- Most worker commands accept `{ input: ... }`.
- Field names use `camelCase` at the Tauri boundary because the Rust input structs use `#[serde(rename_all = "camelCase")]`.
- A successful command resolves to the serialized Rust return value.
- A command returning `Result<T, String>` rejects with the string error if Rust returns `Err`.

## Common Error Shapes

Direct Tauri commands mostly fail as a rejected `invoke()` promise with a string message.

`worker_webui_route` does not reject for ordinary route errors. It returns:

```json
{
  "status": 500,
  "body": {
    "error": {
      "message": "error text"
    }
  },
  "headers": {
    "x-tinybot-route-owner": "rust",
    "x-tinybot-route-group": "sessions"
  }
}
```

Worker RPC uses this response envelope:

```json
{
  "protocol_version": "1",
  "id": "req-1",
  "trace_id": "trace-1",
  "result": {},
  "error": {
    "code": "worker_error",
    "message": "worker crashed",
    "details": {},
    "retryable": true,
    "source": "worker"
  }
}
```

Known worker error codes:

- `invalid_protocol`
- `incompatible_protocol_version`
- `capability_denied`
- `worker_error`

Known worker error sources:

- `rust_core`
- `worker`

## Core Desktop Commands

| Command | Args | Response |
| --- | --- | --- |
| `desktop_status` | none | `{ app_name, gateway_http, gateway_ws, browser_mode }` |
| `gateway_status` | none | `GatewayRuntimeStatus` |
| `start_gateway` | none | `GatewayRuntimeStatus` |
| `stop_gateway` | none | `GatewayRuntimeStatus` |
| `set_gateway_keep_running` | `{ keepRunning: boolean }` | `GatewayRuntimeStatus` |
| `worker_probe_status` | none | `WorkerRuntimeStatus` |
| `worker_echo_agent` | `{ input: string }` | `{ ok, echo, configValue, workspaceFileCount }`; diagnostic/test route |

`GatewayRuntimeStatus` includes:

```json
{
  "state": "running",
  "owner": "shell",
  "http_ok": true,
  "gateway_http": "http://127.0.0.1:18790",
  "gateway_ws": "ws://127.0.0.1:18790/ws",
  "command": "Tauri Rust backend",
  "port": 18790,
  "repo_root": "...",
  "log_path": "...",
  "log_tail": [],
  "logs": [],
  "last_error": null,
  "exit_policy": "stop_on_exit",
  "bootstrap_status": "ready",
  "response_class": "tinybot-bootstrap",
  "recovery_hint": null,
  "worker_runtime": {},
  "agent_tasks": {
    "accepting": true,
    "activeRuns": 0,
    "drainingRuns": 0
  },
  "route_owner_summary": { "rustOwned": 0, "unsupported": 0 },
  "webui_route_inventory": [],
  "compatibility_fallback_diagnostics": [],
  "lifecycle": {
    "startupReconciled": true,
    "lastStartupRecovery": {
      "scannedThreads": 0,
      "scannedRunRecords": 0,
      "interruptedRuns": [],
      "awaitingInteractionRuns": [],
      "resumableRuns": []
    },
    "lastShutdown": null,
    "diagnostics": []
  }
}
```

`lifecycle` is the queryable native-runtime recovery and cleanup record. Startup pauses new agent
runs until both thread journals and their SQLite projections pass consistency checks. The startup
report includes `threadPersistence`, `threadPersistenceMigration`, `sessionLogIndex`, and
`sessionLogIndexMigration`. A legacy SQLite-only thread store and a missing session-log index are
migrated by named startup migrations; an actual log/index divergence fails startup and requires an
explicit repair command. A persisted `running` run with no live owner is then closed as
`status: "interrupted"`, `phase: "interrupted"`, and
`stopReason: "runtime_restarted"`; waiting runs and their checkpoints remain unchanged. A storage
error leaves the task runtime non-accepting, sets `state: "failed"`/`last_error`, and appends a
`startup_recovery` diagnostic instead of silently continuing.

## File Dialog Commands

| Command | Args | Response |
| --- | --- | --- |
| `pick_upload_file` | `{ options: { title?: string, filters?: { name: string, extensions: string[] }[] } }` | `null` when cancelled, or `{ name, path, mime_type, size_bytes, bytes }` |
| `save_export_file` | `{ options: { title?: string, defaultPath?: string, filters?: Filter[], contents: string } }` | `null` when cancelled, or `{ path }` |
| `reveal_workspace_file` | `{ path: string }` | `void` |

`reveal_workspace_file` only accepts these workspace-relative paths:

- `AGENTS.md`
- `SOUL.md`
- `SYSTEM.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `memory/MEMORY.md`

`SYSTEM.md` is the editable native-agent system-prompt template. The backend creates it once when
missing and reloads it for each workspace-backed turn. Supported placeholders are `{{identity}}`,
`{{working_directory}}`, and `{{operating_system}}`. Empty templates, unknown placeholders, and
malformed delimiters fail explicitly. `{{working_directory}}` resolves to the run `cwd` (or thread
`metadata.workingDirectory`) rather than the directory that stores Tinybot state.

Before each workspace-backed run, the native runtime composes one ordered instruction stream with
source provenance. Increasing precedence is:

1. built-in Tinybot identity (`100`);
2. explicit turn `developerInstructions` (`200`);
3. editable workspace `SYSTEM.md` (`300`);
4. optional workspace `SOUL.md`, `USER.md`, and `TOOLS.md` (`400`, `410`, `420`);
5. project `AGENTS.md` scopes from the nearest `.git` root to the effective working directory
   (`500 + depth`), with `AGENTS.override.md` replacing `AGENTS.md` at the same scope;
6. explicitly selected skill files (`700 + index`);
7. `collaborationMode` and `agentRole` instructions (`800`, `810`);
8. generated working-directory and operating-system facts (`900`).

The four turn fields may appear at the run root or under `metadata`; snake_case aliases are also
accepted. `selectedSkills` is an ordered array of names. Workspace `skills/<name>/SKILL.md` wins over
the bundled `builtin-skills/<name>/SKILL.md`; invalid, duplicate, or missing selected skill names fail
before provider dispatch. Workspace profile and skill files have a 64 KiB per-file limit, while
project instructions share a 64 KiB aggregate budget. Invalid UTF-8, unreadable paths, invalid field
types, truncation, and empty sources are surfaced instead of silently disappearing.

## Config Commands

| Command | Args | Response |
| --- | --- | --- |
| `get_settings_snapshot` | none | `SettingsSnapshot` |
| `get_config_editor_snapshot` | none | `ConfigEditorSnapshot` |
| `apply_config_patch_result` | `{ result: ConfigPatchBridgeResult }` | `ConfigPatchApplyResult` |
| `apply_config_operations` | `{ request: ConfigOperationRequest }` | `ConfigPatchApplyResult` |

Config commands use `$HOME/.tinybot/config.json`. On Rust backend startup, and before each config
command loads the store, the backend ensures the config file exists. If the file is missing it creates
a schema v1 default config with:

- `schemaVersion: 1`
- `agents.defaults.activeProfile: "deepseek-default"`
- `agents.defaults.model: "deepseek-v4-pro"`
- `providers.profiles.deepseek-default` with DeepSeek V4 models
- `gateway.host: "127.0.0.1"` and `gateway.port: 18790`

Existing files are never overwritten by this initialization path, including invalid JSON or non-object
config files. If default creation succeeds, config snapshots include an info diagnostic with code
`DefaultConfigCreated`. If default creation fails, snapshots still return effective in-memory defaults
and include a warning diagnostic with code `DefaultConfigCreateFailed`.

Infrastructure failures reject config commands with a structured IPC payload instead of a plain
string:

```json
{
  "code": "load_config_store",
  "message": "failed to read configuration",
  "configPath": "C:\\Users\\example\\.tinybot\\config.json"
}
```

Stable `code` values are `initialize_default_config`, `load_config_store`, `apply_config_patch`,
`apply_config_operations`, and `reconcile_mcp_runtime`. Validation and revision conflicts remain
successful `ConfigPatchApplyResult` responses with `ok: false`; the structured IPC error is reserved
for failures that prevent the operation from producing a valid application result.

`SettingsSnapshot` is the Rust-owned settings control-center projection for the first settings MVP.
It is intended for frontend settings UI callers that need grouped fields, scope/source metadata,
readonly runtime status, and secret-safe field metadata without reading arbitrary raw config JSON.
Returned field paths are canonical camelCase config paths; legacy snake_case paths are accepted for
read compatibility and normalized on save.

```json
{
  "areas": [
    { "id": "core", "label": "Core" },
    { "id": "application", "label": "Application" },
    { "id": "system", "label": "System" }
  ],
  "groups": [
    {
      "id": "provider-models",
      "label": "Provider & Models",
      "area": "core",
      "fields": [
        {
          "id": "provider-profile-openai-work-api-key",
          "label": "API key",
          "path": "providers.profiles.openai-work.apiKey",
          "scope": "profile",
          "source": "secret",
          "valueType": "secret",
          "editable": true,
          "value": null,
          "secret": {
            "configured": true,
            "revealable": true,
            "copyable": true,
            "exportable": false,
            "loggable": false,
            "displayValue": "********"
          },
          "risk": "sensitive",
          "sideEffect": "none"
        }
      ]
    }
  ],
  "configPath": ".../.tinybot/config.json",
  "revision": "hash",
  "diagnostics": []
}
```

First-version group ids returned by `get_settings_snapshot`:

- `general`
- `provider-models`
- `workspace`
- `mcp-servers`
- `skills`
- `automations`
- `gateway-runtime`
- `security-approvals`
- `logs-diagnostics`
- `expert-config`

The first version intentionally does not include Knowledge, Memory, Cowork, Channels, generic
web/exec/browser tool toggles, telemetry/crash-report controls, or raw JSON editing fields.
`gateway.host` is projected as readonly `127.0.0.1`; `gateway.port` is editable. Secret fields
return `value: null` with `secret` metadata and must remain redacted in exported/public config.
Provider selection is profile-based. New config should use `agents.defaults.activeProfile` and
`providers.profiles.<profileId>.provider`; `agents.defaults.provider: "auto"` is a legacy value only.
The built-in provider catalog currently exposes only `deepseek`, `dashscope`, and `openai`.

OpenAI-compatible provider profiles accept separate network deadlines:

- `requestTimeoutMs` / `request_timeout_ms` / `timeoutMs` / `timeout_ms`: deadline for creating a
  non-stream response or opening a streaming response. The default is `120000` ms.
- `streamIdleTimeoutMs` / `stream_idle_timeout_ms`: maximum time between streaming chunks. It
  defaults to the resolved request timeout.

The `mcp-servers` group projects live MCP runtime state. Each configured server has readonly
`status` and `tool_count` fields populated from the Gateway-owned runtime rather than static
placeholders. Status values are `disabled`, `starting`, `ready`, `failed`, `stopping`, or `stopped`.
Streamable HTTP servers also expose endpoint, bearer-token environment-variable, static header,
environment-backed header, and timeout settings. Sensitive static headers such as
`Authorization` are returned as secret fields with `value: null`.

Provider model discovery:

- `deepseek` uses the OpenAI-compatible `GET {apiBase}/models` API. The default `apiBase` is
  `https://api.deepseek.com`, so discovery calls `https://api.deepseek.com/models`.
- `openai` uses `GET https://api.openai.com/v1/models` by default.
- `dashscope` uses the same OpenAI-compatible model discovery shape against its configured
  `apiBase`, so the default discovery URL is
  `https://dashscope.aliyuncs.com/compatible-mode/v1/models`.

`POST /api/provider-models` accepts `{ provider, profile, apiBase, refreshLive }`. When
`refreshLive: true` is used for an OpenAI-compatible provider, the backend reads the configured
profile API key server-side and merges live results into the returned `models` list with source
`live`. Missing credentials or unsupported discovery are returned as `warning` without exposing
secrets.

`ConfigEditorSnapshot`:

```json
{
  "configPath": ".../.tinybot/config.json",
  "revision": "hash",
  "explicitPublicConfig": {},
  "effectivePublicConfig": {},
  "origins": {},
  "diagnostics": [],
  "secretPresence": {}
}
```

The editor snapshot is intended for expert/debug views and public config summaries. Regular Settings
UI should prefer `SettingsSnapshot` once the frontend is migrated to the Rust-owned settings schema.

`ConfigOperationRequest`:

```json
{
  "expectedRevision": "optional-current-revision",
  "operations": [
    { "op": "replace", "path": "agents.defaults.model", "value": "deepseek-v4-pro" },
    { "op": "replace", "path": "agents.defaults.activeProfile", "value": "deepseek-default" },
    { "op": "remove", "path": "agents.defaults.timezone" },
    { "op": "secretReplace", "path": "providers.profiles.deepseek-default.apiKey", "value": "sk-..." },
    { "op": "secretRemove", "path": "providers.profiles.deepseek-default.apiKey" }
  ]
}
```

`ConfigPatchApplyResult`:

```json
{
  "ok": true,
  "config": {},
  "revision": "new-revision",
  "updatedFields": ["agents.defaults.model"],
  "sideEffects": {
    "applied": [],
    "restartRequired": [],
    "warnings": []
  },
  "error": null
}
```

## Agent Runtime Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_run_agent` | `{ input: { spec: NativeBackendRunSpec } }` | JSON result from native agent runtime |
| `worker_run_agent_input` | `{ input: { input: unknown } }` | JSON result from native agent runtime |
| `worker_cancel_agent` | `{ input: { runId: string } }` | JSON result |
| `worker_restore_agent_checkpoint` | `{ input: { sessionId: string } }` | JSON result |
| `worker_submit_agent_form` | `{ input: { sessionId, formId, values?, action? } }` | JSON result |
| `worker_resume_agent_approval` | `{ input: { sessionId, approvalId, approved, scope?, guidance? } }` | JSON result |

Workspace-backed agent results include:

- `instructionProvenance`: the effective working directory, a SHA-256 hash of the complete model
  instruction text, and ordered source records. Each source records `kind`, path identifier,
  precedence, scope root, load timestamp, source hash, truncation state, and validation warnings.
- `instructionDiagnostics`: structured warnings derived from the source records.
- `traceContext`: stable `requestId`, `traceId`, `runId`, `turnId`, optional `threadId`, and optional
  `parentRunId` values shared by runtime events and durable run records.
- `runMetrics`: the turn duration and terminal outcome for the completed invocation.
- `contextContributions`: ordered, content-free diagnostics for enabled context contributors. Each
  record includes `contributorId`, `kind`, `status`, `contentChars`, `contentSha256`,
  `referenceCount`, safe reference identifiers, and `truncated`.

The instruction provenance and instruction diagnostics are stored on the durable agent-run record, so
`worker_agent_runs_list` and `worker_agent_run_runtime_state` can explain the instruction inputs of
a historical run without persisting a second write authority.

### Extension contributors and context hydration

Native tools are assembled through ordered `ToolContributor` registrations. Built-in workspace
tools and the generic MCP call tool have named contributors, while each discovered MCP server adds
one contributor for its validated dynamic tools. Duplicate contributor IDs, tool IDs, or tool
methods fail before the registry becomes active. The former direct dynamic-tool injection path is
not used by the agent runtime.

Workspace-backed turns hydrate provider context through ordered `AgentContextContributor`
registrations after continuation state is restored and before the first provider request. The
default order is memory followed by knowledge:

- Memory retrieval requires `memory.enabled: true`. `max_notes`/`maxNotes` defaults to `6` and must
  not exceed `20`; `max_chars`/`maxChars` defaults to `1600` and must not exceed `12000`.
- Knowledge retrieval requires both `knowledge.enabled: true` and
  `knowledge.auto_retrieve`/`autoRetrieve: true`. `max_chunks`/`maxChunks` defaults to `5` and must
  not exceed `20`.

Malformed sections, incorrectly typed fields, out-of-range limits, and enabled-contributor
retrieval failures stop the run before provider execution. Contributed text is JSON-encoded and
appended after the composed system instructions under an explicit evidence-only frame; retrieved
text never receives instruction precedence.

Enabled contributors emit the debug event `agent.context.hydrated`, including `empty` evaluations
when no source matched. This event follows the durable runtime trace path. The event and top-level
`contextContributions` projection contain hashes, counts, truncation state, and allowlisted source
identifiers only. They do not contain prompt text, memory content, knowledge excerpts, document
names, or filesystem paths.

### Hooks, trace correlation, and runtime metrics

The native runtime evaluates typed hooks at provider, tool, permission, turn, thread, and context
compaction boundaries. Hook decisions are `continue`, `deny` with a non-empty reason,
`replace_normalized_input` for the supported pre-tool boundary, or
`append_diagnostic_metadata`. Returning a decision at an unsupported stage, returning malformed
diagnostic metadata, or throwing a hook error fails the run explicitly; hook failures are never
converted into successful tool or provider results.

Every native agent `runtimeEvents` entry includes the same `traceContext` object. Provider boundary events add
`providerAttemptId`; tool events retain `itemId`/`toolCallId`. Internal tool, thread, trace, and
persistence Worker RPC requests reuse the root `traceId` and derive operation-specific request IDs.
Thread checkpoints/items or direct-session `AgentRunRecord` values persist the correlation context
so approval/form continuations and post-restart diagnostics do not create an unrelated trace.
Approval continuation specs restore the checkpoint `traceContext`, and approved tool continuations
return and persist traced `runtimeEvents` for the approval decision, tool result, usage, and terminal
boundary. Persisted tool envelopes apply the same config-secret redaction used by live events.

`runtime.metrics` returns a process-local, secret-safe operational snapshot:

```json
{
  "schemaVersion": 1,
  "generatedAtUnixMs": 0,
  "counters": {
    "turn.started": 1,
    "provider.attempted": 1,
    "tool.completed": 1,
    "approval.resolved": 1,
    "cancellation.cleanup.completed": 1,
    "mcp.server.start.completed": 1,
    "mcp.server.stop.completed": 1,
    "process.start.completed": 1,
    "process.stop.completed": 1,
    "recovery.orphaned_runs.interrupted": 1
  },
  "durations": {
    "turn.durationMs": { "count": 1, "totalMs": 20, "maxMs": 20, "averageMs": 20.0 },
    "provider.durationMs": { "count": 1, "totalMs": 8, "maxMs": 8, "averageMs": 8.0 },
    "approval.wait.durationMs": { "count": 1, "totalMs": 12, "maxMs": 12, "averageMs": 12.0 },
    "cancellation.cleanup.durationMs": { "count": 1, "totalMs": 4, "maxMs": 4, "averageMs": 4.0 },
    "mcp.server.start.durationMs": { "count": 1, "totalMs": 30, "maxMs": 30, "averageMs": 30.0 },
    "process.stop.durationMs": { "count": 1, "totalMs": 10, "maxMs": 10, "averageMs": 10.0 },
    "recovery.orphaned_runs.durationMs": { "count": 1, "totalMs": 6, "maxMs": 6, "averageMs": 6.0 }
  },
  "gauges": {
    "context.tokens.before": 1200,
    "context.tokens.after": 600
  }
}
```

Metric names and outcomes come from bounded runtime enums. Prompts, tool output, secrets, and memory
content are not used as metric names or labels.
Approval wait time is restored from the durable checkpoint timestamp. Cancellation cleanup, MCP
server lifecycle, owned shell-process lifecycle, and orphaned-run reconciliation use fixed metric
names; server names, process IDs, run IDs, and trace IDs are never metric keys.

### Typed agent items and provider capabilities

The native runtime converts legacy message JSON into a typed `AgentItem` history before building a
provider request. The internal vocabulary covers instructions, user and assistant messages,
reasoning, tool results and calls, approvals, user-input forms, plan progress, subagent lifecycle,
context compaction, errors, usage, and file references. Chat Completions message objects remain a
compatibility projection owned by `ChatCompletionsAdapter`; they are not the runtime domain model.

History encoding and provider response decoding are strict. Unknown roles, unsupported content
parts, missing tool-call IDs or names, malformed tool-call arrays, invalid usage numbers, and
non-string assistant content return an error before the runtime can persist or dispatch a partial
turn. Tool, approval, and form continuations construct typed assistant/tool-result items before
projecting the existing persisted message shape.

Each `NativeAgentRunContext` also owns an immutable `AgentTurnSettings` snapshot parsed from the run
spec, metadata, and agent defaults. It includes model, provider, iteration and streaming limits,
maximum completion tokens, context-window strategy, reasoning options, service tier, output schema,
working directory, approval policy, permission profile, selected tools, and parallel-tool policy.
Invalid values fail request construction rather than being reread differently by later stages.

Optional provider features must be declared explicitly under the selected provider:

```json
{
  "providers": {
    "fixture": {
      "capabilities": {
        "serviceTier": true,
        "reasoning": true,
        "structuredOutput": true
      }
    }
  }
}
```

`capabilities` may instead be an array containing `service_tier`, `reasoning`, and/or
`structured_output` (camel-case spellings are also accepted). A requested undeclared feature fails
with the provider ID and missing capability. Declared settings map to Chat Completions fields as
follows: service tier to `service_tier`, reasoning effort to `reasoning_effort`, reasoning summary
configuration to `reasoning`, and output schemas to `response_format.type = "json_schema"`.

Turn-level runtime controls are also typed and validated before MCP discovery or provider dispatch:

- `workingDirectory`/`cwd` must resolve to an existing directory inside the workspace. The composed
  instruction provenance and provider context use that directory, and shell tools inherit its
  workspace-relative path when their call does not provide `workingDir`.
- `approvalPolicy` accepts `on_request` (also `on-request`) or `never`. `never` removes
  approval-required tools from the turn; explicitly selecting one is a validation error.
- `permissionProfile` currently accepts only `local-worker`, which selects the native desktop
  capability policy. Unknown profiles fail explicitly.
- `selectedTools` is an optional exact allowlist of tool IDs or methods. Deferred selections activate
  for that turn; unknown, unavailable, or duplicate selections fail. An omitted or empty list keeps
  the normal registry.

### Agent task ownership

Every native run attempt is registered under one in-process task owner before system-prompt loading,
provider execution, or tool dispatch. The owner tracks run/session identity, generation, current
phase, cancellation request/reason, waiting checkpoint reference, terminal outcome, and ignored
late-result count. A duplicate active run ID is rejected. An approval/form continuation starts a new
generation only after the previous execution task has completed into a non-terminal waiting phase.

Cancellation is idempotent and writes one owner terminal outcome. Normal async runs remain active in
the `cancelling` phase while owned child operations perform their bounded cleanup. The owner is
removed only after the run returns a cancellation or cleanup-timeout result. A late result cannot
replace that terminal result. `worker_cancel_agent` includes the cancellation request transition:

```json
{
  "runtime": "rust",
  "runId": "run-1",
  "cancelled": true,
  "stopReason": "cancelled",
  "task": {
    "runId": "run-1",
    "state": "cancel_requested",
    "reason": "user_requested",
    "activeTaskRemoved": false,
    "cleanupPending": true
  }
}
```

Possible task states are `cancel_requested`, `cancelled_waiting`, `already_terminal`, and
`not_found`. A repeated request for an already-cancelled run replays the owned cancellation result
without starting another task.

The desktop `thread.interrupt` path first persists the thread cancellation item and then cancels the
same run owner. Its existing thread result gains `taskCancellation`, containing the same
`worker_cancel_agent` payload. Gateway shutdown follows one ordered path: stop accepting starts,
cancel and drain owned runs, terminate retained shell process trees, stop MCP clients/stdio children,
interrupt non-terminal subagents, stop the background worker, and emit a `RuntimeShutdownReport`.
For cooperative agent tasks, shutdown requests cancellation without publishing a terminal result;
the cancellation or cleanup-timeout result becomes visible only after the owned operation has
finished its bounded cleanup. Shutdown waits for both cancelling active tasks and draining tasks.
Each bounded stage continues after an earlier failure. Cleanup failures are returned as a combined
error, retained in `GatewayRuntimeStatus.lifecycle.diagnostics`, mirrored to `last_error`, and written
to the persistent native-backend log. The report includes agent cleanup, shell process IDs, MCP,
subagent, worker, state-persistence, elapsed-time, and failure details. A same-process gateway restart
reopens agent and shell start admission only after cleanup is complete.

### Async provider execution

The desktop command, native bridge, context-compaction request, provider loop, and
OpenAI-compatible HTTP/SSE implementation are async end to end. Normal execution does not nest
`block_on`. Synchronous helpers remain only as test and compatibility adapters. Tool batches and
approval continuations dispatch through the same async owned-tool path.

Provider cancellation is checked before a request, while opening a response, between SSE chunks,
and immediately before and after each stream observer callback. Cancelling the owning run drops the
provider future. Once the task owner publishes cancellation, a late chunk or provider result cannot
emit `agent.delta`, `agent.reasoning_delta`, `agent.done`, or replace the terminal result.

Provider failures do not retry automatically and preserve distinct `stopReason` values:

- `cancelled`
- `provider_request_timeout`
- `provider_stream_idle_timeout`
- `provider_transport_error`
- `provider_error`

Timeout, transport, and provider failures emit `agent.error` with the same `stopReason`. A provider
cancellation follows the normal `agent.cancelled` path.

### Owned tool execution and cleanup

Every dispatched tool call runs under an owned task handle and a child cancellation token. Parallel
read scheduling, exclusive write scheduling, model-order result projection, single terminal
ownership, and late-result diagnostics remain unchanged. The parent run retains each handle until
the task has joined; dropping an incomplete batch cancels and aborts every remaining wrapper task.
The approval-resume path uses the same ownership boundary instead of a nested synchronous dispatch.
Production providers and tool dispatchers must implement their async seam. The synchronous trait
bridge exists only in unit-test builds; it fails explicitly in production instead of creating an
unregistered blocking task. Tinybot's provider, MCP path, subagent dispatcher, and general tool
executor all execute inside the registered provider/tool future, so cancellation cannot detach a
lower-level `spawn_blocking` operation from the run owner.

Tool teardown is selected from the registry runtime policy:

- `cooperative`: notify the tool and wait up to its cleanup timeout; cancellation remains a normal
  `cancelled` result if the future does not finish in that interval.
- `terminate_process`: require the implementation to terminate its owned process after receiving
  cancellation.
- `detach_forbidden`: require the operation to return from cleanup before the run is considered
  cleanly cancelled.

Built-in cooperative tools default to `100 ms`; process-owning and detach-forbidden tools default to
`2000 ms`. Queued and running `agent.tool.start` payloads expose `runtimePolicy` with
`cancellationMode`, `cleanupTimeoutMs`, `waitsForRuntimeCancellation`, `mutatesWorkspace`, and
`mutatesSession`.

If `terminate_process` or `detach_forbidden` cleanup exceeds its bound, the run returns
`stopReason: "tool_cleanup_timeout"` and emits `agent.tool.cleanup_timeout` with the tool call ID,
tool name, cancellation mode, and timeout. If the outer run itself cannot finish cooperative
cleanup within five seconds, the task owner returns `stopReason: "cancellation_cleanup_timeout"`
and emits `agent.cleanup_timeout`. Neither timeout is reported as successful cancellation.

When a tool operation completes successfully during bounded cancellation cleanup, its result and
domain events are recorded before the run becomes cancelled. This preserves already-completed side
effects without allowing another provider request. Results that arrive after the owned terminal gate
remain ignored.

`NativeBackendRunSpec`:

```json
{
  "runId": "run-1",
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

### Deferred tool discovery and checkpoints

The native agent provider initially receives the capability-allowed model tools plus the runtime
control tools `update_plan` and `tool_search`. `update_plan` remains available when `selectedTools`
limits ordinary tools. Deferred tools are not included until the model searches for them in the
current run.

`update_plan` tracks the execution checklist for non-trivial work. Every call replaces the complete
plan snapshot for the current run:

```json
{
  "explanation": "The repository inspection changed the implementation order.",
  "plan": [
    { "step": "Inspect the timeline model", "status": "completed" },
    { "step": "Implement plan updates", "status": "in_progress" },
    { "step": "Run acceptance tests", "status": "pending" }
  ]
}
```

Statuses are `pending`, `in_progress`, and `completed`. An incomplete plan must have exactly one
`in_progress` step; a completed plan has none. Empty, duplicate, oversized, unknown, or inconsistent
input returns an explicit tool error to the model so it can correct the snapshot without terminating
the turn. A valid update returns `Plan updated` to the model and emits one
`agent.plan.progress` item keyed by `<runId>:plan`; later calls revise that item instead of adding
rows. Derived `completed`, `total`, and `currentStep` values are validated against `steps`. The event
and its canonical timeline patch use the normal trace persistence path, so live delivery and reload
project the same plan item.

The catalog is the deterministic projection of registered tool contributors. Workspace tools,
generic MCP dispatch, and per-server MCP discovery all enter through this registry; feature-specific
tool arrays are not appended directly by the provider loop.

Scheduling, cancellation, mutation classification, and approval metadata are read from the same
visible registry entry used for provider exposure and dispatch. The generic `mcp.call_tool` entry is
serialized because it can mutate both workspace and session state. Server configuration and fixture
annotations cannot override that policy during dispatch. Per-server discovered MCP tools may be
parallel-safe only when their registry entry was built with a read-only or server-parallel policy.

`tool_search` input:

```json
{
  "query": "shell or file editing capability",
  "limit": 5
}
```

The result contains a minimal activation projection and does not expose capability grants or
credentials:

```json
{
  "tools": [
    {
      "toolId": "exec_command",
      "title": "Start shell command",
      "description": "Start a workspace shell command and retain it when it remains active.",
      "requiresApproval": true
    }
  ]
}
```

Returned deferred tools become provider-visible only for the current run. A fresh or terminal run
does not inherit them. Calls to deferred tools that were not activated fail with
`stopReason: "policy_denied"` before dispatch.

Resumable checkpoints include the validated activation set:

```json
{
  "schemaVersion": 1,
  "phase": "awaiting_approval",
  "activatedToolIds": ["workspace.write_file"],
  "pendingToolCalls": [
    {
      "toolCallId": "call-write-1",
      "toolName": "workspace.write_file",
      "argumentsJson": "{\"path\":\"notes.txt\",\"contents\":\"hello\"}"
    }
  ]
}
```

Approval-required tools return `stopReason: "awaiting_approval"` and persist the pending call before
normal dispatch. Approval and form continuations revalidate every `activatedToolIds` entry against
the current registry and capability policy; stale IDs, malformed arrays, provider-name collisions,
and approval IDs that do not match the checkpoint return explicit errors. Cancelled and other
terminal checkpoints expose an empty activation set.

An approved continuation dispatches the persisted call through the same registry execution target,
records the real tool result, and resumes the provider loop. It does not synthesize a successful
approval result. Denial records the denied result without invoking the tool.

### Model-requested user input

The capability-allowed provider tool list includes the runtime control tool `request_user_input`.
It requires `form.request` and accepts a strict structured form:

```json
{
  "title": "Choose a target",
  "description": "Select the environment to update.",
  "submit_label": "Continue",
  "cancel_label": "Stop",
  "fields": [
    {
      "name": "environment",
      "type": "select",
      "label": "Environment",
      "required": true,
      "options": [
        { "label": "Development", "value": "dev" },
        { "label": "Production", "value": "prod" }
      ]
    }
  ]
}
```

Supported field types are `text`, `textarea`, `number`, `select`, `multiselect`, `radio`, and
`checkbox`. Choice fields require an explicit option list. Unknown properties, unsafe or duplicate
field names, unsupported option values, missing required values, and values with the wrong JSON
type fail explicitly.

The tool persists an `awaiting_form` checkpoint with `kind: "user_input"`, the pending tool call,
the assistant message that owns it, and the current model context. It then emits
`agent.awaiting_form` and returns `stopReason: "awaiting_form"`. `worker_submit_agent_form` must use
the matching `sessionId` and `formId`. A valid submit becomes the real tool observation and resumes
the same provider chain; it is not converted into a synthetic final answer. Cancel clears the
checkpoint and returns `stopReason: "form_cancelled"` with an observable resolution/error event.

## Session Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_sessions_list` | none | session list payload |
| `worker_session_messages` | `{ input: { key: string } }` | `{ messages: [...] }` style payload |
| `worker_agent_runs_list` | `{ input: { key: string } }` | agent run list |
| `worker_agent_run_runtime_state` | `{ input: { sessionKey: string, runId: string } }` | `AgentRunRuntimeState` |
| `worker_session_temporary_files` | `{ input: { key: string } }` | temporary file list |
| `worker_session_upload_temporary_file` | `{ input: { key: string, body: { name, file_type, content, size_bytes? } } }` | uploaded file payload |
| `worker_session_clear_temporary_files` | `{ input: { key: string } }` | clear result |
| `worker_session_delete` | `{ input: { key: string } }` | delete result |
| `worker_session_patch` | `{ input: { key: string, body: { title?, metadata?, archived? } } }` | patched session payload |
| `worker_session_branch` | `{ input: { body: unknown } }` | branch result |
| `worker_session_clear` | `{ input: { key: string } }` | clear result |
| `worker_session_task_progress` | `{ input: { key: string, body: unknown } }` | task progress result |

`worker_agent_run_runtime_state` returns raw runtime events for diagnostics and one canonical
timeline snapshot for product rendering. The former `turnItems` response field is not part of the
contract.

```json
{
  "runtimeEvents": [],
  "timeline": {
    "schemaVersion": "tinybot.timeline.v1",
    "sessionId": "websocket:chat-1",
    "runId": "run-1",
    "snapshotRevision": 2,
    "items": [
      {
        "schemaVersion": "tinybot.turn_item.v1",
        "itemId": "message-1",
        "sessionId": "websocket:chat-1",
        "runId": "run-1",
        "turnId": "run-1",
        "sequence": 4,
        "revision": 2,
        "kind": "assistant_message",
        "status": "completed",
        "createdAt": "2026-07-11T00:00:00Z",
        "updatedAt": "2026-07-11T00:00:01Z",
        "data": {
          "type": "assistant_message",
          "messageId": "message-1",
          "content": "Done"
        }
      }
    ]
  }
}
```

`item.sequence` is the source runtime-event position and never changes for an existing item.
`item.revision` advances for each mutation of that item. `snapshotRevision` counts canonical
timeline mutations only; diagnostic runtime events that do not produce an item do not advance it.
This makes live patch revisions contiguous while preserving source ordering.

Canonical `user_message` data also carries optional `clientEventId`. The desktop sends this ID in
the WebSocket message frame, the native transport preserves it in the Agent input, and the runtime
echoes it in the canonical user item. It is a reconciliation identity and does not replace the
durable `messageId`.

Product-facing canonical item data includes the following lifecycle details:

- `form`: `formId`, `fieldIds`, `status`, optional `action`, submitted `values`, and validation
  `errors`. The canonical item owns lifecycle/result state; the Agent UI form registry remains the
  authority for interactive field definitions.
- `plan_progress`: optional `explanation`, the complete typed `steps` snapshot, and backend-derived
  `completed`, `total`, and optional `currentStep`.
- `context_compaction`: `droppedItemCount` plus optional `estimatedTokensBefore` and
  `estimatedTokensAfter`.
- `file_reference`: stable `id`, `path`, optional `mimeType`, and `referenceKind`. `parentItemId`
  associates the reference with its owning Tool, Form, or Subagent item.
- `error`: `code`, `message`, and `cancelled`. An error with `parentItemId` is scoped to its owner;
  errors without a parent remain terminal timeline rows.

The desktop loads Subagent traces and artifact content through
`worker_background_trace_get_delegate_trace` and `worker_background_trace_get_artifact`. Timeline
paths are metadata only and are never used directly as browser image URLs. Raster previews accept
only backend-returned base64 `data:image` content for PNG, JPEG, GIF, or WebP; SVG and arbitrary
URLs remain inert text/metadata.

Key response shapes used by the lower-level session RPC:

```json
{
  "session_id": "websocket:chat-1",
  "title": "Chat title",
  "workspace_dir": "D:/code/tinybot/tinybot",
  "created_at": "2026-07-06T00:00:00Z",
  "updated_at": "2026-07-06T00:00:00Z",
  "extra": {}
}
```

```json
{
  "session_id": "websocket:chat-1",
  "run_id": "run-1",
  "status": "running",
  "phase": "tool_calling",
  "started_at": "...",
  "updated_at": "...",
  "completed_at": null,
  "model": "deepseek-v4-pro",
  "provider": "deepseek",
  "hasCheckpoint": true,
  "finalContentPreview": "..."
}
```

## Session and Thread Persistence

Tinybot keeps the existing `session.*` API surface for frontend compatibility while separating two
explicit persistence authorities:

- `thread.*` writes append versioned operations to `.tinybot/state/thread-store.jsonl`, flushes and
  syncs that journal, and only then updates `.tinybot/threads/threads.sqlite`. The SQLite database is
  a rebuildable timeline/list/search projection.
- compatibility `session.*` history and `agent_run.*` lifecycle data append to per-session JSONL
  files under `.tinybot/threads/YYYY/MM/DD/thread-*.jsonl` before updating
  `.tinybot/state/state.sqlite`. That SQLite database is a rebuildable session index.

Thread journal operations carry `schemaVersion: 1` and `operationId`. Thread-log metadata carries
`schemaVersion: 1`; legacy metadata without the field is read as v0. Unsupported future versions
fail explicitly instead of being guessed or silently downgraded.

Compatibility `session.*` and `agent_run.*` routes keep their response shapes for older callers, but
new writes do not mirror completed history, checkpoints, metadata patches, or agent-run lifecycle
events into the legacy `.tinybot/threads/threads.sqlite` projection. Those routes write their own
canonical store (`thread_log` for durable history and usage, legacy `sessions.sqlite` only for
legacy active session state). When a session key belongs to a canonical thread, compatibility
metadata, history, and checkpoint reads prefer the `ThreadStore` projection; old session JSONL data
cannot override the thread timeline.
Compatibility reads first check whether a ThreadStore projection exists. A workspace that has only
direct-session state does not create an empty `threads.sqlite` file and does not acquire thread-read
capabilities merely to prove that no canonical thread exists.
Compatibility `session.persist_turn`, session checkpoint mutation, and `agent_run.*` lifecycle
writes return a structured authority error for a thread-owned session instead of creating a second
durable record.
Native agent lifecycle persistence is fail-fast: a terminal-run lookup or run-start write failure
returns a command error before the provider is called, and a run-record write failure returns a
command error instead of embedding a failed `runPersistence` diagnostic in an otherwise successful
result.
Thread-owned commands such as `worker_submit_thread_turn`, `worker_resolve_thread_approval`, and
`worker_submit_thread_form` update the thread timeline explicitly through `thread.start_turn` and
`thread.apply_op`. Their runtime events, run state, resumable checkpoint, approvals/forms, and final
assistant or error item all append to `.tinybot/state/thread-store.jsonl`. They do not create a
per-session JSONL file. Their native-agent result contains
`conversationPersistence.authority: "thread"` and `runPersistence.authority: "thread"`.
The terminal run item retains instruction provenance and diagnostics, so compatibility
`agent_run.get` projections preserve the effective working directory and instruction sources.
Approval/form continuation restores `latestCheckpoint.restorePayload` from `ThreadStore`, including
after a new runtime instance starts; a later terminal item makes that checkpoint inactive. Direct
non-thread agent commands continue to persist run lifecycle and completed conversation through the
session JSONL authority and `session.persist_turn`.

`clientEventId` is the retry/idempotency key for thread appends, starts, continuations, approvals,
forms, and forks. A successful retry replays the original item IDs instead of appending another
logical operation. The local and in-memory stores implement the same `ThreadStore` contract, and
`ThreadRuntime`/`LiveThread` operate on that interface.

Persistence verification and repair are lower-level Worker RPC methods:

| Method | Params | Behavior |
| --- | --- | --- |
| `thread.persistence.check` | `{}` | Compare the canonical thread journal, journal head, records, items, and SQLite projection. |
| `thread.persistence.repair` | `{ mode: "migrate_legacy_projection" | "rebuild_projection" }` | Create journal v1 from a legacy projection, or rebuild the projection from the journal. |
| `session.persistence.check` | `{}` | Compare canonical session JSONL records with `state.sqlite`. |
| `session.persistence.repair` | `{ mode: "rebuild_index" }` | Rebuild `state.sqlite` from canonical session logs. |

Normal reads never run these repairs. `clean`, `legacy_projection`/`missing_index`, `diverged`, and
`unreadable` are observable states; writes fail while their authority is not clean.

`session.get_history` returns frontend-compatible messages. When a thread has token usage, the
backend derives the message `usage` field from the latest persisted `token_count` event. A malformed
thread log line, malformed `token_count` event, or malformed compaction payload is treated as a
backend error instead of being silently ignored.

## Thread Commands

Thread Tauri commands all use `{ input: { body } }`, except the continuation helper commands listed separately.

| Command | Worker RPC method | Body |
| --- | --- | --- |
| `worker_thread_create` | `thread.create` | `CreateThreadRequest` |
| `worker_thread_read` | `thread.read` | `ReadThreadRequest` |
| `worker_thread_resume` | `thread.resume` | `ResumeThreadRequest` |
| `worker_threads_list` | `thread.list` | `ListThreadsRequest` |
| `worker_thread_search` | `thread.search` | `SearchThreadsRequest` |
| `worker_thread_activity` | `thread.activity` | `ThreadActivityRequest` |
| `worker_thread_status` | `thread.status` | `{ threadId }` |
| `worker_thread_update_metadata` | `thread.update_metadata` | `UpdateThreadMetadataRequest` |
| `worker_thread_agent_registry` | `thread.agent_registry` | `ThreadAgentRegistryRequest` |
| `worker_thread_start_turn` | `thread.start_turn` | `StartThreadTurnRequest` |
| `worker_thread_continue_turn` | `thread.continue_turn` | `ContinueThreadTurnRequest` |
| `worker_thread_interrupt` | `thread.interrupt` | `InterruptThreadRequest` |
| `worker_thread_apply_op` | `thread.apply_op` | `ThreadApplyOpRequest` |
| `worker_thread_archive` | `thread.archive` | `ArchiveThreadRequest` |
| `worker_thread_unarchive` | `thread.unarchive` | `ArchiveThreadRequest` with `archived: false` |
| `worker_thread_delete` | `thread.delete` | `DeleteThreadRequest` |
| `worker_thread_fork` | `thread.fork` | `ForkThreadRequest` |
| `worker_thread_events` | `thread.events` | `ThreadEventsRequest` |
| `worker_thread_restore_checkpoint` | `thread.restore_checkpoint` | `RestoreThreadCheckpointRequest` |

Thread continuation helper commands:

| Command | Args |
| --- | --- |
| `worker_submit_thread_turn` | `{ input: { threadId?: string, input: unknown, spec?: unknown } }` |
| `worker_resolve_thread_approval` | `{ input: { threadId, approvalId, approved, scope?, guidance? } }` |
| `worker_submit_thread_form` | `{ input: { threadId, formId, values?, action? } }` |

`ThreadRecord`:

```json
{
  "threadId": "thread-1",
  "title": "New session",
  "status": "idle",
  "sessionKey": "websocket:chat-1",
  "rootRunId": "run-1",
  "activeRunId": null,
  "parentThreadId": null,
  "source": "desktop",
  "createdAt": "...",
  "updatedAt": "...",
  "archivedAt": null,
  "metadata": {
    "summary": null,
    "preview": null,
    "tags": [],
    "model": null,
    "workingDirectory": null,
    "itemCount": 0,
    "runCount": 0,
    "hasActiveRun": false,
    "extra": {}
  }
}
```

`ThreadSnapshot`:

```json
{
  "thread": {},
  "items": [],
  "runs": [],
  "activeRun": null,
  "latestCheckpoint": null,
  "children": [],
  "turnItems": [],
  "childActivities": [],
  "pagination": {
    "cursor": "0",
    "limit": 100,
    "itemCount": 0,
    "previousCursor": null,
    "nextCursor": null,
    "hasMoreBefore": false,
    "hasMoreAfter": false
  },
  "nextCursor": null
}
```

Thread statuses:

- `empty`
- `idle`
- `running`
- `waiting_for_input`
- `waiting_for_approval`
- `cancelling`
- `failed`
- `archived`

## Skills Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_skills_list` | none | `{ skills: [...] }` or WebUI list shape |
| `worker_skills_detail` | `{ input: { name } }` | skill detail |
| `worker_skills_create` | `{ input: { body } }` | created skill |
| `worker_skills_update` | `{ input: { name, body } }` | updated skill |
| `worker_skills_delete` | `{ input: { name } }` | delete result |
| `worker_skills_validate` | `{ input: { name } }` | validation result |

## Workspace Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_workspace_files` | none | `{ files: WorkspaceFileEntry[] }` |
| `worker_workspace_file` | `{ input: { path } }` | `WorkspaceReadFileResult` |
| `worker_workspace_put_file` | `{ input: { path, body } }` | `WorkspaceWriteResult` |

Lower-level workspace RPC also supports:

- `workspace.resolve_path`
- `workspace.read_file`
- `workspace.read_bootstrap_files`
- `workspace.write_file`
- `workspace.apply_patch`
- `workspace.create_dir`
- `workspace.list_dir`
- `workspace.delete_file`
- `workspace.list_files`

`WorkspaceReadFileResult`:

```json
{
  "path": "README.md",
  "contents": "...",
  "content": "...",
  "updated_at": "2026-07-06T00:00:00Z",
  "content_type": "text/plain",
  "line_start": 1,
  "line_end": 100,
  "line_total": 250,
  "truncated": false
}
```

`workspace.apply_patch` accepts:

```json
{
  "patch": "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch",
  "sessionId": "websocket:chat-1",
  "runId": "run-1"
}
```

The patch grammar is strict and supports `*** Add File: path`, `*** Update File: path`, and
`*** Delete File: path` operations between `*** Begin Patch` and `*** End Patch`. Update hunks begin
with `@@`; each following line starts with a space, `+`, or `-`. Context must have one exact match.
The backend does not perform fuzzy matching.

All targets are validated before writing. Paths must stay inside the workspace, symlink escapes and
non-regular update/delete targets are rejected, add cannot overwrite, and a file may appear only
once per patch. Limits are 4 MiB, 256 file operations, and 256 hunks per updated file. Each changed
file is written atomically, and updated files preserve their existing LF or CRLF line ending.

Result shape:

```json
{
  "changed_files": [
    {
      "path": "README.md",
      "operation": "update",
      "hunks": [{ "index": 1, "removed_lines": 1, "added_lines": 1 }]
    }
  ],
  "files_changed": 1,
  "hunks_applied": 1
}
```

`workspace.apply_patch`, `workspace.write_file`, `workspace.delete_file`, `shell.execute`,
`shell.start`, and MCP tool calls enforce their final approval boundary at the concrete Worker RPC
method. A caller cannot claim an internal operation in serialized params: the trusted marker exists
only on an in-process request after the native runtime has passed its approval gate.

Approval fingerprints are derived by the worker from the normalized operation and permission
effects. Concrete workspace, shell, and MCP boundaries recompute their fingerprint from the actual
request; caller-supplied fingerprint fields are not trusted. Low-level `approval.request` rejects a
fingerprint, session fingerprint, or effect set that does not match the normalized request. For
known tools it replaces caller-authored category, risk, reason, summary, scope, and lifetime with
the authoritative tool presentation before showing the request to the user.

`permission_profile.evaluate_tool` and approval payloads include normalized `effects`:

```json
{
  "filesystem": {
    "readRoots": ["filesystem://unrestricted"],
    "writeRoots": ["filesystem://unrestricted"]
  },
  "network": {
    "mode": "unrestricted",
    "destinations": ["network://unrestricted"]
  },
  "process": { "execute": true, "interactive": false },
  "environment": {
    "inherit": true,
    "secretScopes": ["environment://ambient-process"]
  },
  "mcp": [],
  "mutatesSession": false,
  "mutatesBackground": false,
  "sandboxMode": "unsandboxed"
}
```

Workspace tools use exact workspace-relative write roots where possible; strict multi-file patches
use the whole current workspace. MCP effects name both destination server and tool. Subagent tools
mark session/background mutation. Effect lists are sorted and deduplicated before a SHA-256-bound
approval fingerprint is created, so changing sandbox, network, filesystem, interactive-process, or
secret scope invalidates an earlier grant.

## Owned Shell Processes

The Rust worker owns live shell processes behind `WorkerShellRpc`. `shell.execute` remains the
one-shot compatibility method, but it now starts and waits through the same process manager used by
interactive sessions. Its returned stdout/stderr is bounded by the manager's retained transcript.
The manager is held by `NativeAgentRuntimeServices`, so separate per-tool Worker RPC router instances
share the same live process store.

Model-visible deferred tools map to the richer RPC surface:

| Tool | Worker RPC target | Approval | Cancellation policy |
| --- | --- | --- | --- |
| `exec_command` | `shell.start` | per command | `terminate_process` |
| `write_stdin` | `shell.write_stdin` | none after launch | `detach_forbidden` |

The worker overwrites tool-supplied identity fields with the active `sessionId`, `runId`, and
`toolCallId` when these tools dispatch. An owned process cannot be polled, written, resized,
interrupted, or terminated without the matching `runId`.

### Shell RPC methods

| Method | Purpose |
| --- | --- |
| `shell.start` | Start a pipe or PTY process and wait for a bounded initial yield. |
| `shell.poll` | Return output after a sequence cursor, waiting up to `yieldTimeMs`. |
| `shell.write_stdin` | Write `input` (or alias `chars`) and return newly available output. |
| `shell.resize` | Resize an active PTY in rows and columns. |
| `shell.interrupt` | Send SIGINT on Unix or Ctrl-C to a Windows PTY. |
| `shell.terminate` | Terminate one owned process tree and verify its exit. |
| `shell.terminate_run` | Terminate all live processes owned by one run. |
| `shell.list` | List retained process snapshots, optionally filtered by `runId`. |
| `shell.shutdown` | Terminate live processes, join terminal lifecycle threads, and release records. |

`shell.start` accepts:

```json
{
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "yieldTimeMs": 1000,
  "rows": 24,
  "cols": 80,
  "sandboxMode": "unsandboxed",
  "networkMode": "unrestricted",
  "sessionId": "websocket:chat-1",
  "runId": "run-1",
  "toolCallId": "call-1"
}
```

`runId` and `toolCallId` are required for retained processes. The one-shot `shell.execute` adapter
uses an internal transient owner and releases its record before returning.

`sandboxMode` accepts `unsandboxed` (the default) or `read_only`. `networkMode` accepts
`unrestricted` (the default), `configured`, or `denied`. Tinybot currently has no arbitrary-shell
network isolation adapter, so `configured` and `denied` fail before process creation instead of
claiming enforcement. Windows supports `read_only` for pipe processes through a restricted,
low-integrity primary token plus a kill-on-close Job Object. This blocks writes to the normal
medium-integrity workspace even when its discretionary ACL grants Everyone write access. Windows
objects deliberately labeled low integrity remain writable and appear in normalized effects as
`windows://low-integrity`. Read-only PTY requests and read-only requests on platforms without an
adapter fail closed.

Windows unsandboxed pipe processes also receive a dedicated kill-on-close Job Object immediately
after creation. Failure to create or assign that job fails the start and terminates the direct child.
`shell.terminate`, run cancellation, and gateway shutdown terminate the job and verify the root
record reaches terminal state, preventing descendants from retaining inherited pipe handles or
surviving the owner.

Process snapshots use camel-case fields and include:

```json
{
  "processId": "process-1",
  "systemProcessId": 1234,
  "runId": "run-1",
  "toolCallId": "call-1",
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "status": "running",
  "running": true,
  "exitCode": null,
  "stdout": "",
  "stderr": "",
  "output": "",
  "chunks": [],
  "cursor": 0,
  "truncated": false,
  "droppedBytes": 0,
  "startedAtMs": 0,
  "lastActivityMs": 0,
  "sandboxMode": "unsandboxed_approved",
  "networkMode": "unrestricted",
  "approvalDecision": "approved",
  "failure": null
}
```

Pipe processes preserve stdout/stderr chunk identity. PTY output uses the `terminal` stream and is
projected into stdout for compatibility. The retained transcript keeps a 256 KiB head and 768 KiB
tail; `truncated` and `droppedBytes` make any omission explicit. Unknown process IDs and writes after
exit are errors, not empty successful polls. On Windows, the manager normalizes terminal input,
answers ConPTY cursor-position probes internally, and removes verbatim path prefixes only at the PTY
spawn boundary after workspace validation. Windows read-only pipe processes are created suspended,
assigned to a kill-on-close Job Object before resume, and report
`windows_restricted_low_integrity_read_only` as their actual sandbox label. `approvalDecision` is
`approved`, `trusted_internal`, or `internal_direct` according to the launch boundary.

## Knowledge Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_knowledge_documents` | `{ input: { category?: string, limit?: number } }` | documents list |
| `worker_knowledge_add_document` | `{ input: { body } }` | document/job payload |
| `worker_knowledge_document` | `{ input: { docId } }` | document detail |
| `worker_knowledge_delete_document` | `{ input: { docId } }` | delete result |
| `worker_knowledge_job` | `{ input: { jobId } }` | job detail |
| `worker_knowledge_rebuild_index` | `{ input: { rebuildType?: string } }` | rebuild job/result |
| `worker_knowledge_stats` | none | knowledge stats |
| `worker_knowledge_graph` | `{ input: { docId?, graphType?, limit?, edgeLimit?, minConfidence?, includeOrphans? } }` | graph payload |

Lower-level knowledge RPC additionally supports:

- `knowledge.context`
- `knowledge.query`
- `knowledge.start_index_job`
- `knowledge.document_tree`
- `knowledge.save_entity_graph_extraction`
- `knowledge.session_upload`
- `knowledge.session_list`
- `knowledge.session_clear`

## Background, Task, Subagent, Transport, and Channel Commands

| Group | Commands |
| --- | --- |
| Background trace | `worker_background_trace_list`, `worker_background_trace_get_delegate_trace`, `worker_background_trace_get_artifact`, `worker_background_trace_append` |
| Background subagent input | `worker_background_subagent_enqueue_input` |
| Subagent manager | `worker_subagent_spawn`, `worker_subagent_list`, `worker_subagent_query`, `worker_subagent_send_input`, `worker_subagent_wait`, `worker_subagent_cancel`, `worker_subagent_close`, `worker_subagent_resume` |
| Task plans | `worker_task_plan_list`, `worker_task_plan_get`, `worker_task_plan_save`, `worker_task_plan_delete` |
| Transport | `worker_transport_gateway_frame`, `worker_transport_websocket_message`, `worker_transport_dispatch_websocket_message` |
| Channel connector | `worker_channel_dispatch_inbound`, `worker_channel_start`, `worker_channel_status`, `worker_channel_stop`, `worker_channel_login` |
| Cron | `worker_cron_dispatch_due` |
| Cowork proxy | `worker_cowork_route` |
| WebUI proxy | `worker_webui_route` |

### Subagent lifecycle

The desktop commands and model-visible tools share the same manager and canonical thread store.
Model-visible lifecycle tools are `subagent.spawn`, `subagent.send_input`, `subagent.wait`,
`subagent.close`, and `subagent.resume`; `subagent.list`, `subagent.query`, and `subagent.cancel`
remain Worker RPC and desktop-control operations.

The default limits are eight active children per session, 32 active children process-wide, and a
maximum delegation depth of four. Nested spawns must name their direct `parentSubagentId` and exact
`delegationDepth`; the persisted child thread is attached to that direct parent's thread. Capacity
and depth failures are explicit control errors and do not create partial durable edges.

`historyMode` controls the public conversation copied into a child thread:

- `isolated` copies no parent messages;
- `parent_turn` copies user and completed assistant messages from the latest user turn;
- `full_history` copies all user and completed assistant messages.

Reasoning, tool calls and outputs, approvals, and private trace items are never inherited. Copied
messages contain source-thread and source-item provenance and use deterministic child item IDs.

After a process restart, canonically persisted active children are restored as `interrupted`.
`subagent.resume` selectively returns one interrupted child to `running`; explicitly closed or
otherwise terminal children cannot be reopened. `close` is a lifecycle retention decision, while
`cancel` records task cancellation; completed, failed, cancelled, and interrupted children remain
queryable until explicitly closed. `subagent.wait` blocks until a selected child reaches a waiting
or terminal boundary, the timeout expires, or the parent request is cancelled. The timeout defaults
to 30 seconds and is capped at 30 seconds. Waiting does not write polling snapshots into thread
history.

Transport input examples:

```ts
await invoke("worker_transport_dispatch_websocket_message", {
  input: {
    clientId: "client-1",
    frame: { type: "message", content: "hello" },
    attachedChatId: "chat-1",
    sessionExists: true,
    editablePaths: ["src/main.ts"],
    model: "deepseek-v4-pro",
    maxIterations: 20,
    runId: "run-1",
    stream: true
  }
});
```

Channel login:

```ts
await invoke("worker_channel_login", {
  input: { channel: "slack", force: false }
});
```

## WebUI Route Wrapper

Call:

```ts
const response = await invoke("worker_webui_route", {
  input: {
    method: "GET",
    path: "/api/status",
    headers: {},
    body: null
  }
});
```

Response:

```json
{
  "status": 200,
  "body": {},
  "headers": {
    "x-tinybot-route-owner": "rust",
    "x-tinybot-route-group": "status"
  }
}
```

The frontend helper `createDesktopNativeWebuiApi().route()` unwraps 2xx responses and throws for non-2xx responses.
Use `routeResponse()` if the status and headers are needed.

### Rust-owned WebUI Routes

| Method | Path | Group | Notes |
| --- | --- | --- | --- |
| `GET` | `/health` | health | Native health check |
| `GET` | `/webui/bootstrap` | bootstrap | Returns `{ token, ws_path, refresh_token_path, token_ttl_s }` |
| `POST` | `/webui/refresh-token` | bootstrap | Returns a fresh bootstrap token |
| `GET` | `/api/status` | status | Runtime status body |
| `GET` | `/api/config` | config | Public config snapshot |
| `GET` | `/api/providers` | providers | Provider catalog |
| `POST` | `/api/provider-models` | providers | Provider model resolution |
| `GET` | `/v1/models` | openai | OpenAI-compatible model list |
| `POST` | `/v1/chat/completions` | openai | OpenAI-compatible chat completion route |
| `GET` | `/api/approvals` | approvals | Optional query: `session_key`, `chat_id`, `channel` |
| `POST` | `/api/approvals/{approval_id}/approve` | approvals | Approval continuation |
| `POST` | `/api/approvals/{approval_id}/deny` | approvals | Approval continuation |
| `POST` | `/api/agent-ui/forms/{form_id}/submit` | agent-ui | Form continuation |
| `POST` | `/api/agent-ui/forms/{form_id}/cancel` | agent-ui | Form cancellation |
| `GET` | `/api/sessions` | sessions | List sessions |
| `GET` | `/api/sessions/{key}/messages` | sessions | List session messages |
| `POST` | `/api/sessions/branch` | sessions | Branch from message/session body |
| `PATCH` | `/api/sessions/{key}` | sessions | Patch session metadata/title/archive state |
| `DELETE` | `/api/sessions/{key}` | sessions | Delete session |
| `POST` | `/api/sessions/{key}/clear` | sessions | Clear messages/profile/checkpoint |
| `GET` | `/api/sessions/{key}/temporary-files` | sessions | List temporary files |
| `POST` | `/api/sessions/{key}/temporary-files` | sessions | Upload text temporary file |
| `DELETE` | `/api/sessions/{key}/temporary-files` | sessions | Clear temporary files |
| `GET` | `/api/skills` | skills | List skills |
| `POST` | `/api/skills` | skills | Create skill |
| `GET` | `/api/skills/{name}` | skills | Skill detail |
| `PATCH` | `/api/skills/{name}` | skills | Update skill |
| `DELETE` | `/api/skills/{name}` | skills | Delete skill |
| `POST` | `/api/skills/{name}/validate` | skills | Validate skill |
| `GET` | `/api/workspace/files` | workspace | List workspace files |
| `GET` | `/api/workspace/files/{path:.+}` | workspace | Read workspace file |
| `PUT` | `/api/workspace/files/{path:.+}` | workspace | Write workspace file |
| `GET` | `/v1/knowledge/documents` | knowledge | Query: `category`, `limit` |
| `POST` | `/v1/knowledge/documents` | knowledge | Add document |
| `POST` | `/v1/knowledge/documents/upload` | knowledge | Add uploaded text document |
| `GET` | `/v1/knowledge/documents/{doc_id}` | knowledge | Document detail |
| `DELETE` | `/v1/knowledge/documents/{doc_id}` | knowledge | Delete document |
| `GET` | `/v1/knowledge/stats` | knowledge | Stats |
| `GET` | `/v1/knowledge/jobs/{job_id}` | knowledge | Job detail |
| `POST` | `/v1/knowledge/rebuild-index` | knowledge | Query currently reads `type`; direct command uses `rebuildType` |
| `GET` | `/v1/knowledge/graph` | knowledge | Query: `doc_id`, `graph_type`, `limit`, `edge_limit`, `min_confidence`, `include_orphans` |

### Inventoried But Unsupported WebUI Routes

These return status `501` through `worker_webui_route`:

| Method | Path | Reason |
| --- | --- | --- |
| `PATCH` | `/api/config` | Config patch route is not implemented in Rust WebUI route surface |
| `POST` | `/v1/knowledge/query` | Advanced query route is not exposed as WebUI route |
| `POST` | `/v1/knowledge/graph/extract` | LLM graph extraction orchestration is not exposed as WebUI route |
| `GET` | `/v1/knowledge/graphrag` | GraphRAG route is not exposed as WebUI route |
| `GET/POST/PATCH/DELETE` | `/api/cowork/{path:.+}` | Cowork HTTP routes are not exposed by Rust WebUI route inventory |
| `GET` | `/api/tools` | Native tool catalog route is not exposed yet |

Unknown, non-inventoried routes return status `404` with:

```json
{
  "diagnostic": "unsupported-route",
  "inventoryStatus": "not-inventoried",
  "routeGroup": "unknown",
  "error": { "message": "webui control route unavailable" },
  "method": "GET",
  "path": "/missing",
  "route": "GET /missing"
}
```

## Worker RPC Protocol

The lower-level worker RPC router uses this request shape:

```json
{
  "protocol_version": "1",
  "id": "req-1",
  "trace_id": "trace-1",
  "method": "workspace.read_file",
  "params": {
    "path": "README.md"
  }
}
```

It is primarily used internally by Rust command handlers through `call_rust_state_service`.
External callers should usually prefer the Tauri commands above.

### Supported Worker RPC Methods

| Namespace | Methods |
| --- | --- |
| `agent_run` | `append_trace`, `clear_checkpoint`, `get`, `get_checkpoint`, `list`, `list_trace`, `mark_cancelled`, `mark_completed`, `mark_failed`, `runtime_state`, `set_checkpoint`, `upsert` |
| `approval` | `list_pending`, `request`, `resolve` |
| `config` | `apply_operations`, `apply_patch_result`, `get`, `snapshot_public` |
| `diagnostics` | `append` |
| `form` | `request` |
| `knowledge` | `add_document`, `context`, `delete_document`, `document_tree`, `get_document`, `get_job`, `graph`, `list_documents`, `query`, `rebuild_index`, `save_entity_graph_extraction`, `session_clear`, `session_list`, `session_upload`, `start_index_job`, `stats` |
| `mcp` | `call_tool`, `diagnostics`, `list_tools`, `server_status`, `shutdown` |
| `memory` | `capture_evidence`, `dream_apply`, `dream_log`, `dream_pending`, `dream_restore`, `dream_run`, `list_evidence`, `migrate_legacy_notes`, `rebuild_index`, `recall`, `refresh_views`, `reject`, `save`, `search`, `supersede`, `trace` |
| `permission_profile` | `current`, `evaluate_tool`, `request_tool_approval`, `resolve_tool_approval` |
| `provider` | `resolve_secret` |
| `rag` | `query` |
| `runtime` | `metrics`, `now`, `restart` |
| `session` | `append_messages`, `clear`, `clear_checkpoint`, `delete`, `get_checkpoint`, `get_history`, `get_metadata`, `list_metadata`, `patch_metadata`, `patch_user_profile`, `persist_turn`, `set_checkpoint`, `trim` |
| `shell` | `execute`, `start`, `poll`, `write_stdin`, `resize`, `interrupt`, `terminate`, `terminate_run`, `list`, `shutdown` |
| `skills` | `list`, `webui_create`, `webui_delete`, `webui_detail`, `webui_list`, `webui_update`, `webui_validate` |
| `subagent` | `cancel`, `close`, `list`, `query`, `resume`, `send_input`, `spawn`, `wait` |
| `thread` | `activity`, `agent_registry`, `append_items`, `apply_op`, `archive`, `continue_turn`, `create`, `delete`, `events`, `fork`, `interrupt`, `list`, `read`, `restore_checkpoint`, `resume`, `search`, `start_turn`, `status`, `unarchive`, `update_metadata` |
| `tool_executor` | `execute` |
| `tool_registry` | `list`, `search` |
| `workspace` | `apply_patch`, `create_dir`, `delete_file`, `list_dir`, `list_files`, `read_bootstrap_files`, `read_file`, `resolve_path`, `write_file` |

### MCP Runtime RPC

The Gateway owns one long-lived MCP runtime shared by Worker RPC adapters and native agent turns.
Short-lived adapters do not own child processes or HTTP sessions. A configuration update with the
`mcpConfigChanged` side effect reconciles changed, disabled, and removed servers; Gateway shutdown
closes HTTP sessions and terminates stdio children before stopping the worker.

Accepted transport values:

- `stdio`: starts the configured command directly without a shell;
- `http`, `streamable_http`, and `streamable-http`: use MCP Streamable HTTP;
- `sse`: rejected as an unsupported legacy transport; there is no fallback.

Configured server maps are normalized from `tools.mcp_servers`, `tools.mcpServers`, or
`mcp.servers`. All MCP status, discovery, reconciliation, Worker RPC, and native-agent dispatch
paths use the same normalized map.

Stdio configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "local-search": {
        "enabled": true,
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": { "LOG_LEVEL": "info" },
        "envVarRefs": { "SEARCH_API_TOKEN": "TINYBOT_SEARCH_API_TOKEN" }
      }
    }
  }
}
```

`env` may contain non-sensitive process settings. Keys ending in token, secret, password,
authorization, credentials, or API key are rejected when supplied inline. `envVarRefs` maps child
environment names to host environment-variable names and resolves them only at server startup.
Missing, empty, or non-Unicode referenced values fail explicitly without echoing the value.
Snake-case `env_var_refs` is also accepted.

Streamable HTTP configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "docs": {
        "enabled": true,
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnvVar": "DOCS_MCP_TOKEN",
        "httpHeaders": { "X-Tenant": "tinybot" },
        "envHttpHeaders": { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
        "startupTimeoutSeconds": 10,
        "timeoutSeconds": 30,
        "enabledTools": ["search"]
      }
    }
  }
}
```

`bearerTokenEnvVar` and `envHttpHeaders` contain environment-variable names, not secret values.
Missing, empty, or non-Unicode values fail startup explicitly. Inline `bearerToken` / `bearer_token`
is rejected; use the environment-backed field. URL credentials and fragments are also rejected.
Snake-case aliases are accepted for these fields.

`mcp.list_tools` takes no params and returns enabled servers, normalized real tool schemas, and live
status:

```json
{
  "servers": [
    {
      "name": "docs",
      "status": {
        "state": "ready",
        "transport": "http",
        "toolCount": 4,
        "elapsedMs": 18,
        "lastError": null
      },
      "tools": [{ "name": "search", "inputSchema": { "type": "object" } }]
    }
  ]
}
```

`mcp.call_tool` params and response:

```json
{
  "server": "docs",
  "tool": "search",
  "arguments": { "query": "runtime ownership" }
}
```

```json
{
  "server": "docs",
  "tool": "search",
  "content": [],
  "structuredContent": {},
  "isError": false,
  "result": {}
}
```

The server and tool must be enabled and allowlisted. Discovery and calls support startup/call
timeouts and request cancellation. Cancellation before or during client startup, initialization,
or `tools/list` closes the partial transport, marks the server failed with a cancelled diagnostic,
and stops discovery promptly. Cancellation during an active call uses the same cleanup path. The
next discovery or call starts a clean client.

Additional methods:

- `mcp.server_status` params: `{ "serverId": "docs" }`;
- `mcp.diagnostics`: returns a bounded transition list containing `serverId`, `transport`, `state`,
  `phase`, `elapsedMs`, `errorCode`, and a sanitized `message`;
- `mcp.shutdown`: closes every managed server and returns `{ "stopped": true }`.

## Tauri Event Names

The Rust backend can emit live events through Tauri. Dotted worker event names are normalized for frontend listeners elsewhere, but the native contract inventories these source event names:

- `agent.timeline.patch`
- `agent.delta`
- `agent.reasoning_delta`
- `agent.tool_call.delta`
- `agent.tool.start`
- `agent.tool.result`
- `agent.tool.debug`
- `agent.tool.cleanup_timeout`
- `agent.cleanup_timeout`
- `agent.usage`
- `agent.checkpoint`
- `agent.status`
- `agent.awaiting_form`
- `agent.form.resolution`
- `agent.awaiting_approval`
- `agent.context.compacted`
- `agent.context.trimmed`
- `agent.file.reference`
- `agent.memory_reference`
- `agent.task_progress`
- `agent.browser_frame`
- `agent.delegate.started`
- `agent.delegate.running`
- `agent.delegate.message_queued`
- `agent.delegate.awaiting_approval`
- `agent.delegate.tool.approval_required`
- `agent.delegate.tool.completed`
- `agent.delegate.trace.updated`
- `agent.delegate.completed`
- `agent.delegate.failed`
- `agent.delegate.interrupted`
- `agent.delegate.closed`
- `heartbeat.delivery`
- `agent.cancelled`
- `agent.done`
- `agent.error`
- `diagnostics.log`
- `worker.status`

Semantic runtime events retain their existing compatibility fields and also include a typed
`payload.agentItem` object. The discriminator is `type`. Current production projections cover
approval requests/decisions, form requests/responses, task-plan progress, subagent activity,
context compaction/trimming, errors/cancellation, usage updates, and user file/image references.
Runtime event `itemId` is derived from the same typed item ID, so live delivery, trace persistence,
and replay refer to one semantic item. Unknown or malformed internally constructed semantic events
fail at the projection boundary instead of being persisted as an incomplete item.

`agent.timeline.patch` is the product-facing live update and is produced by the same projector as
the runtime-state snapshot:

```json
{
  "schemaVersion": "tinybot.timeline_patch.v1",
  "sessionId": "websocket:chat-1",
  "runId": "run-1",
  "snapshotRevision": 3,
  "item": {}
}
```

The frontend applies patches by run ID and item ID. A revision gap triggers an authoritative
snapshot reload and reapplication of the received patch. If the reload still cannot close the gap,
the error remains visible. Identity/schema mismatches and terminal-state regressions are rejected;
lower item revisions are ignored with a diagnostic. Raw events remain available for traces but are
not a second Chat state source.

`session.task_progress.upsert` requires the same complete `steps` snapshot and persists the resulting
`plan_progress` item under `_agent_item` in its compatibility progress message. Counter-only payloads
are rejected; provided counters and current-step values must match the backend-derived values. User
message content parts of type `file`, `input_file`,
`image_url`, or `input_image` emit one `agent.file.reference` event per reference; image references
use `referenceKind: "image"` and file references use `referenceKind: "file"`.

`agent.usage` payloads preserve provider-returned OpenAI-compatible usage fields such as
`prompt_tokens`, `completion_tokens`, and `total_tokens`. The Rust agent runtime also appends
context-window budget fields:

- `context_window_tokens` / `contextWindowTokens`: effective context window from
  `agents.defaults.contextWindowTokens` or the backend default.
- `context_window_used_tokens` / `contextWindowUsedTokens`: provider `prompt_tokens` when present,
  then provider `total_tokens`, otherwise the local request estimate.
- `context_window_remaining_tokens` / `contextWindowRemainingTokens`: remaining context budget.
- `estimated_context_tokens` / `estimatedContextTokens`: local approximate token count for the
  request sent after context-window trimming.
- `context_window_strategy` / `contextWindowStrategy`: effective strategy, currently `discard` or
  `compact`.
- `percent`: context-window usage percentage.

Rust agent context-window controls are read from `agents.defaults` or the run spec:

- `contextWindowTokens` / `context_window_tokens`: effective context window. The fallback is
  `128000`.
- `contextWindowStrategy` / `context_window_strategy`: `discard` or `compact`. The fallback is
  `discard`.
- `compactTriggerPercent` / `compact_trigger_percent`: percentage threshold for `compact`; default
  `90`.
- `compactSummaryMaxTokens` / `compact_summary_max_tokens`: max completion tokens for the internal
  summary request; default `1024`.

`discard` keeps the newest messages that fit the window. `compact` sends older messages through an
internal non-streaming `chat/completions` request, inserts the returned summary as a system message,
and keeps recent messages. The summary request uses the same async timeout, cancellation, and typed
failure path as the main provider request; failure is explicit and does not silently fall back to
`discard`.

`NativeBackendEvent` shape:

```json
{
  "sessionId": "websocket:chat-1",
  "runId": "run-1",
  "traceId": "trace-1",
  "eventName": "agent.delta",
  "timestamp": "2026-07-06T00:00:00Z",
  "source": "rust_backend",
  "payload": {}
}
```

## Recommended Frontend Wrappers

Prefer these wrappers instead of direct command strings:

| Wrapper | File | Commands/routes covered |
| --- | --- | --- |
| `createDesktopNativeConfigApi` | `src/app-core/native/desktopNativeConfig.ts` | Config snapshot |
| `createDesktopNativeSessionsApi` | `src/app-core/native/desktopNativeSessions.ts` | Session commands |
| `createDesktopNativeThreadsApi` | `src/app-core/native/desktopNativeThreads.ts` | Thread commands |
| `createDesktopNativeKnowledgeApi` | `src/app-core/native/desktopNativeKnowledge.ts` | Knowledge commands |
| `createDesktopNativeTransportApi` | `src/app-core/native/desktopNativeTransport.ts` | Transport and channel commands |
| `createDesktopNativeWebuiApi` | `src/app-core/native/desktopNativeWebui.ts` | `worker_webui_route` |
| `createGatewayApiClient` | `src/app-core/gateway/gatewayHttpClient.ts` | Chooses native WebUI/native command first, then gateway HTTP fallback when configured |

## Examples

List sessions:

```ts
await invoke("worker_sessions_list");
```

Read session messages:

```ts
await invoke("worker_session_messages", {
  input: { key: "websocket:chat-1" }
});
```

Patch a session title:

```ts
await invoke("worker_session_patch", {
  input: {
    key: "websocket:chat-1",
    body: { title: "Planning notes" }
  }
});
```

Create and read a thread:

```ts
const created = await invoke("worker_thread_create", {
  input: { body: { title: "Investigation" } }
});

const snapshot = await invoke("worker_thread_read", {
  input: { body: { threadId: created.thread.threadId, limit: 100 } }
});
```

Call an HTTP-compatible route through Rust:

```ts
const response = await invoke("worker_webui_route", {
  input: {
    method: "GET",
    path: "/v1/knowledge/documents?limit=20"
  }
});

if (response.status === 200) {
  console.log(response.body);
}
```

Apply a config operation:

```ts
await invoke("apply_config_operations", {
  request: {
    expectedRevision: currentRevision,
    operations: [
      { op: "replace", path: "agents.defaults.model", value: "deepseek-v4-pro" }
    ]
  }
});
```

Read the settings control-center projection:

```ts
const snapshot = await invoke("get_settings_snapshot");
```

