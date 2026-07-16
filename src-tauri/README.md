# Tinybot Rust Backend

This crate is the native backend for Tinybot Desktop. It owns the in-process
Tauri host, the native agent runtime, worker RPC services, runtime lifecycle,
and workspace-backed persistence used by the desktop workbench.

This README is a maintainer map. For frontend-facing command and payload
details, see [the Rust backend API reference](../docs/api/rust-backend-api.md).
For desktop setup and launch behavior, see [the desktop guide](../docs/desktop.md).

## Entry points

- `src/main.rs` starts the Tauri application through `tinybot_desktop_lib::run`.
- `src/lib.rs` assembles shared runtime state and registers Tauri commands.
- `src/desktop_commands/` adapts typed Tauri inputs to backend services.
- `WorkerRpcRouter` handles versioned `WorkerRequest` values for internal and
  transport-backed callers.
- Tauri events carry live agent, timeline, approval, and runtime updates to the
  native workbench.

The default desktop path is in-process. Compatibility fields may mention HTTP
or WebSocket endpoints, but they do not imply that the Tauri backend binds a
local server.

## Architecture

The backend is organized into five broad layers:

1. **Desktop boundary**
   - `lib.rs`, `desktop_commands/`, `desktop_files.rs`, and the desktop menu,
     logging, update, and heartbeat modules.
   - Owns Tauri state, command registration, native dialogs, and frontend
     events.
2. **Application orchestration**
   - [`native_agent_bridge/`](src/native_agent_bridge/README.md) coordinates a
     complete run across history hydration, attachments, tools, trace sinks,
     checkpoints, and persistence.
3. **Runtime core**
   - [`worker_agent_runtime/`](src/worker_agent_runtime/README.md) implements
     the provider/tool loop.
   - [`runtime/`](src/runtime/README.md) owns live tasks, shared MCP state,
     startup recovery, shutdown, and operational metrics.
4. **Service boundary**
   - [`worker_rpc/`](src/worker_rpc/README.md) routes versioned methods to
     capability-checked services such as workspace, shell, memory, tasks,
     tools, and configuration.
5. **Conversation persistence**
   - [`worker_thread/`](src/worker_thread/README.md) is the typed Thread domain
     and its canonical store.
   - [`worker_thread_log/`](src/worker_thread_log/README.md) records and replays
     session-compatible JSONL logs.
   - [`worker_session/`](src/worker_session/README.md) maintains the
     session-shaped compatibility aggregate and direct-session state.

## Typical agent flow

```text
Tauri command / Worker RPC
        |
        v
desktop_commands or WorkerRpcRouter
        |
        v
native_agent_bridge
        |
        +--> worker_agent_runtime --> provider + tools
        |
        +--> worker_thread / worker_thread_log / worker_session
        |
        +--> runtime task ownership + live trace events
```

Keep transport concerns at the boundary. Agent-loop behavior belongs in
`worker_agent_runtime`; cross-service run orchestration belongs in
`native_agent_bridge`; durable Thread state transitions belong in
`worker_thread`.

## Persistence map

The backend currently supports related persistence surfaces with different
roles:

| Path | Owner | Role |
| --- | --- | --- |
| `.tinybot/state/thread-store.jsonl` | `worker_thread::local_store` | Canonical typed Thread journal |
| `.tinybot/threads/threads.sqlite` | `worker_thread::local_store` | Query projection of the canonical Thread journal |
| `.tinybot/threads/<year>/<month>/<day>/*.jsonl` | `worker_thread_log` | Append-only session-compatible thread logs |
| `.tinybot/state/state.sqlite` | `worker_thread_log` | Search/list index for session-compatible logs |
| `<session-root>/sessions/sessions.sqlite` | `worker_session` | Session aggregate snapshots for direct-session and compatibility paths |

Do not treat similarly named stores as interchangeable. Each store has its own
consistency and migration rules, described in its module README.

## Maintenance rules

- Keep Tauri command functions thin; move reusable behavior below the desktop
  boundary.
- Validate capabilities at the service that performs the protected operation.
- Preserve request IDs, trace IDs, run IDs, and client event IDs across layers.
- Do not write directly to a SQLite projection when a canonical journal owns
  the data.
- Surface consistency failures and recovery diagnostics instead of silently
  rebuilding or discarding state.
- Keep external command and payload documentation in
  `docs/api/rust-backend-api.md`; keep implementation invariants next to the
  module that enforces them.
- Update the relevant README when changing module ownership, a persistence
  path, a recovery rule, or the order of a cross-module flow.
