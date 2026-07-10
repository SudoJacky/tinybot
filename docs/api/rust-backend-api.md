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
  "compatibility_fallback_diagnostics": []
}
```

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
malformed delimiters fail explicitly; the backend does not replace an invalid user file with a
hidden fallback prompt.

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

### Agent task ownership

Every native run attempt is registered under one in-process task owner before system-prompt loading,
provider execution, or tool dispatch. The owner tracks run/session identity, generation, current
phase, cancellation request/reason, waiting checkpoint reference, terminal outcome, and ignored
late-result count. A duplicate active run ID is rejected. An approval/form continuation starts a new
generation only after the previous execution task has completed into a non-terminal waiting phase.

Cancellation is idempotent and writes one owner terminal outcome. The task moves out of the active
registry immediately and remains in a private draining registry until its underlying blocking work
returns. A late result cannot replace the cancelled result. `worker_cancel_agent` includes the task
transition:

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
    "activeTaskRemoved": true,
    "cleanupPending": true
  }
}
```

Possible task states are `cancel_requested`, `cancelled_waiting`, `already_terminal`, and
`not_found`. A repeated request for an already-cancelled run replays the owned cancellation result
without starting another task.

The desktop `thread.interrupt` path first persists the thread cancellation item and then cancels the
same run owner. Its existing thread result gains `taskCancellation`, containing the same
`worker_cancel_agent` payload. Gateway shutdown stops accepting starts, cancels active owners, waits
up to five seconds for draining work, continues MCP/worker cleanup even if that wait fails, and
returns an explicit combined error for remaining cleanup failures.

`NativeBackendRunSpec`:

```json
{
  "runId": "run-1",
  "sessionId": "websocket:chat-1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "deepseek-v4-pro",
  "maxIterations": 20,
  "stream": true,
  "metadata": {}
}
```

### Deferred tool discovery and checkpoints

The native agent provider initially receives the capability-allowed model tools plus the runtime
control tool `tool_search`. Deferred tools are not included until the model searches for them in the
current run.

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
      "toolId": "shell.execute",
      "title": "Execute shell command",
      "description": "Run a shell command in the workspace.",
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

Tinybot keeps the existing `session.*` API surface for frontend compatibility. Internally, a
user-visible session maps to a durable backend thread. Each thread is persisted as an append-only
JSONL file under `.tinybot/threads/YYYY/MM/DD/thread-*.jsonl`.

`state.sqlite` lives under `.tinybot/state/state.sqlite` and is a derived index for listing,
session/thread id lookup, archive metadata, and the canonical JSONL path. The JSONL thread file is
the canonical history source.

Compatibility `session.*` and `agent_run.*` routes keep their response shapes for older callers, but
new writes do not mirror completed history, checkpoints, metadata patches, or agent-run lifecycle
events into the legacy `.tinybot/threads/threads.sqlite` projection. Those routes write their own
canonical store (`thread_log` for durable history and usage, legacy `sessions.sqlite` only for
legacy active session state) and read legacy thread projections only as a fallback for existing data.
Thread-owned commands such as `worker_submit_thread_turn`, `worker_resolve_thread_approval`, and
`worker_submit_thread_form` update the thread timeline explicitly through `thread.start_turn` and
`thread.apply_op`.

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
  "runId": "run-1",
  "approvalFingerprint": "optional-once-grant",
  "approvalSessionFingerprint": "optional-session-grant"
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

`workspace.apply_patch`, `workspace.write_file`, `workspace.delete_file`, `shell.execute`, and MCP
tool calls enforce their final approval boundary at the concrete Worker RPC method. A caller cannot
claim an internal operation in serialized params: the trusted marker exists only on an in-process
request after the native runtime has passed its approval gate.

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
| Subagent manager | `worker_subagent_spawn`, `worker_subagent_list`, `worker_subagent_query`, `worker_subagent_send_input`, `worker_subagent_wait`, `worker_subagent_cancel`, `worker_subagent_close` |
| Task plans | `worker_task_plan_list`, `worker_task_plan_get`, `worker_task_plan_save`, `worker_task_plan_delete` |
| Transport | `worker_transport_gateway_frame`, `worker_transport_websocket_message`, `worker_transport_dispatch_websocket_message` |
| Channel connector | `worker_channel_dispatch_inbound`, `worker_channel_start`, `worker_channel_status`, `worker_channel_stop`, `worker_channel_login` |
| Cron | `worker_cron_dispatch_due` |
| Cowork proxy | `worker_cowork_route` |
| WebUI proxy | `worker_webui_route` |

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
| `runtime` | `now`, `restart` |
| `session` | `append_messages`, `clear`, `clear_checkpoint`, `delete`, `get_checkpoint`, `get_history`, `get_metadata`, `list_metadata`, `patch_metadata`, `patch_user_profile`, `persist_turn`, `set_checkpoint`, `trim` |
| `shell` | `execute` |
| `skills` | `list`, `webui_create`, `webui_delete`, `webui_detail`, `webui_list`, `webui_update`, `webui_validate` |
| `subagent` | `cancel`, `close`, `list`, `query`, `send_input`, `spawn`, `wait` |
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

- `agent.delta`
- `agent.reasoning_delta`
- `agent.tool_call.delta`
- `agent.tool.start`
- `agent.tool.result`
- `agent.tool.debug`
- `agent.usage`
- `agent.checkpoint`
- `agent.status`
- `agent.awaiting_form`
- `agent.form.resolution`
- `agent.awaiting_approval`
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
and keeps recent messages. If compaction fails, the runtime falls back to `discard`.

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

