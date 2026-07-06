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
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`
- `memory/MEMORY.md`

## Config Commands

| Command | Args | Response |
| --- | --- | --- |
| `get_config_editor_snapshot` | none | `ConfigEditorSnapshot` |
| `apply_config_patch_result` | `{ result: ConfigPatchBridgeResult }` | `ConfigPatchApplyResult` |
| `apply_config_operations` | `{ request: ConfigOperationRequest }` | `ConfigPatchApplyResult` |

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

`ConfigOperationRequest`:

```json
{
  "expectedRevision": "optional-current-revision",
  "operations": [
    { "op": "replace", "path": "agents.defaults.model", "value": "gpt-5" },
    { "op": "remove", "path": "agents.defaults.timezone" },
    { "op": "secretReplace", "path": "providers.openai.api_key", "value": "sk-..." },
    { "op": "secretRemove", "path": "providers.openai.api_key" }
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

`NativeBackendRunSpec`:

```json
{
  "runId": "run-1",
  "sessionId": "websocket:chat-1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "gpt-5",
  "maxIterations": 20,
  "stream": true,
  "metadata": {}
}
```

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
  "model": "gpt-5",
  "provider": "openai",
  "hasCheckpoint": true,
  "finalContentPreview": "..."
}
```

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
    model: "gpt-5",
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
| `mcp` | `call_tool`, `list_tools` |
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
| `workspace` | `create_dir`, `delete_file`, `list_dir`, `list_files`, `read_bootstrap_files`, `read_file`, `resolve_path`, `write_file` |

## Tauri Event Names

The Rust backend can emit live events through Tauri. Dotted worker event names are normalized for frontend listeners elsewhere, but the native contract inventories these source event names:

- `agent.delta`
- `agent.reasoning_delta`
- `agent.tool_call.delta`
- `agent.tool.start`
- `agent.tool.result`
- `agent.usage`
- `agent.checkpoint`
- `agent.status`
- `agent.awaiting_form`
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
      { op: "replace", path: "agents.defaults.model", value: "gpt-5" }
    ]
  }
});
```

