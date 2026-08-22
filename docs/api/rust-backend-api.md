# Rust Backend API Reference
<!-- tinybot-doc-watch:
src-tauri/src/desktop/bootstrap.rs
src/app-core/native/desktopNativeAgentGraphRuntime.ts
src/app-core/native/desktopNativeConfig.ts
src/app-core/native/desktopNativeHostCommand.ts
src/app-core/native/desktopNativeTerminal.ts
src/app-core/native/desktopNativeThreads.ts
src/app-core/native/desktopNativeUpdate.ts
src/app-core/native/desktopNativeWebui.ts
src/app-core/native/nativeBackendContract.test.ts
-->
<!-- tinybot-doc-fingerprint: sha256:9a155543af3d5c5db59ff927b659222d94f2624aeae95dcf1e4c71dea01fe6f8 -->

This document describes the API surfaces exposed by the Rust/Tauri backend in `src-tauri`.
It is intended for frontend callers and integrators who need command names, invocation
patterns, response envelopes, and the current Rust-owned route inventory.

The documentation fingerprint above records the reviewed public contract
definitions and frontend contract tests. A watched-source change requires this
reference set to be reviewed before CI accepts it.

## API Documents

The reference is split by runtime area so callers can find a contract without loading the
entire backend inventory.

| Area | Reference |
| --- | --- |
| Desktop lifecycle, dialogs, diagnostics, updates, configuration, and command-hook trust | [Desktop commands](desktop.md) |
| Agent turns, provider behavior, cancellation, and checkpoints | [Agent runtime](agent-runtime.md) |
| Timeline queries, memory, persistence, project groups, and Threads | [Threads and memory](threads-and-memory.md) |
| Skills, Agent Plugins, and workspace operations | [Workspace and extensions](workspace-and-extensions.md) |
| Shell sessions, background work, subagents, Chat retry compatibility, and browser sessions | [Tools and processes](tools-and-processes.md) |
| Rust-owned WebUI routes and Worker/MCP RPC methods | [WebUI and Worker RPC](webui-and-worker-rpc.md) |
| Live runtime events emitted through Tauri | [Tauri events](events.md) |

## Surfaces

The Rust backend is reachable through four surfaces:

1. Tauri commands registered in `src-tauri/src/desktop/bootstrap.rs`.
2. `worker_webui_route`, a Tauri command that emulates HTTP/WebUI routes and returns an HTTP-like response envelope.
3. Worker RPC methods handled by `WorkerRpcRouter`.
4. Tauri events emitted for live agent/runtime updates.

Most desktop frontend code should prefer typed wrappers under `src/app-core/native/*`.
Direct `invoke()` calls are still documented here because they are the actual backend contract.

## Tauri Invocation Contract

Use Tauri's `invoke` API:

```ts
import { invoke } from "@tauri-apps/api/core";

const threads = await invoke("worker_threads_list", {
  input: { body: {} },
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
    "x-tinybot-route-group": "workspace"
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

## Recommended Frontend Wrappers

Prefer these wrappers instead of direct command strings:

| Wrapper | File | Commands/routes covered |
| --- | --- | --- |
| `createDesktopNativeAgentGraphsApi` | `src/app-core/native/desktopNativeAgentGraphs.ts` | Workspace Agent Graph definition list/save/delete |
| `createDesktopNativeAgentGraphRuntime` | `src/app-core/native/desktopNativeAgentGraphRuntime.ts` | Graph Run history and saved-revision execution |
| `createDesktopNativeConfigApi` | `src/app-core/native/desktopNativeConfig.ts` | Config snapshot |
| `createDesktopNativeHooksApi` | `src/app-core/native/desktopNativeHooks.ts` | Workspace hook catalog, managed-hook save/test/archive, constrained script editing, and exact-definition trust |
| `createDesktopNativeUpdateClient` | `src/app-core/native/desktopNativeUpdate.ts` | Desktop update status, check, install, and status events |
| `createDesktopNativeThreadsApi` | `src/app-core/native/desktopNativeThreads.ts` | Thread, Turn timeline, and effective-capability commands |
| `createDesktopNativeHostCommandApi` | `src/app-core/native/desktopNativeHostCommand.ts` | Transitional Chat `operation.retry` dispatch |
| `createDesktopNativeTerminalApi` | `src/app-core/native/desktopNativeTerminal.ts` | User-only Sidecar terminal lifecycle and PTY input/output |
| `createDesktopNativeWebuiApi` | `src/app-core/native/desktopNativeWebui.ts` | `worker_webui_route` |

## Examples

List Thread turns:

```ts
await invoke("thread_list_turns", {
  input: { body: { threadId: "thread-1" } }
});
```

Read canonical Turn runtime state:

```ts
await invoke("thread_get_turn_runtime_state", {
  input: { body: { threadId: "thread-1", turnId: "turn-1" } }
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
    path: "/api/workspace/files"
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
