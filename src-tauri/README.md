# Tinybot Rust Backend

This single crate is the native backend for Tinybot Desktop. It owns the
in-process Tauri host, the native agent runtime, RPC services, runtime
lifecycle, and workspace-backed persistence used by the desktop workbench.

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

The crate is organized by responsibility. `src/lib.rs` keeps these modules
private and exposes the desktop application boundary instead of re-exporting
the implementation tree.

The main layers are:

1. **Desktop boundary**
   - `lib.rs`, `desktop_commands/`, `desktop_files.rs`, and the desktop menu,
     logging, update, and heartbeat modules.
   - Owns Tauri state, command registration, native dialogs, and frontend
     events.
2. **Protocol and dispatch boundary**
   - `protocol/` owns versioned envelopes, capability types, request IDs, and
     parameter validation.
   - [`rpc/`](src/rpc/README.md) dispatches validated requests to the owning
     service without absorbing domain behavior.
3. **Agent execution**
   - [`agent/runtime/`](src/agent/runtime/README.md) implements the injected
     provider/tool loop without Tauri or persistence dependencies.
   - [`agent/bridge/`](src/agent/bridge/README.md) coordinates a complete run
     across history hydration, attachments, tools, trace sinks, checkpoints,
     and persistence.
   - `agent/provider.rs` and `agent/runtime_protocol.rs` keep provider and
     runtime-event boundary types beside the agent subsystem.
4. **Conversation domain and persistence**
   - [`threads/domain/`](src/threads/domain/README.md) owns typed Thread state
     and in-process projections.
   - `threads/rollout/format/` owns typed, versioned Rollout lines and pure
     reconstruction.
   - [`threads/rollout/store/`](src/threads/rollout/store/README.md) owns
     canonical append-only Rollouts and their rebuildable SQLite index.
   - [`threads/session/`](src/threads/session/README.md) exposes session-shaped
     projections of canonical Rollouts.
5. **Domain services**
   - `workspace/`, `memory/`, `tools/`, `automation/`, `collaboration/`, and
     `config/` own their business rules and do not depend on RPC or Tauri.
6. **Process and transport infrastructure**
   - [`runtime/`](src/runtime/README.md) owns live tasks, shared MCP state,
     startup recovery, shutdown, and operational metrics.
   - `transport/stdio_worker/` contains the optional stdio worker process,
     connection, codec, client, status, and diagnostics implementation.
   - `storage/` contains shared atomic file-write primitives.

## Typical agent flow

```text
Tauri command / Worker RPC
        |
        v
desktop_commands or WorkerRpcRouter
        |
        v
agent::bridge
        |
        +--> agent::runtime --> provider + injected tools
        |
        +--> threads::rollout::store canonical Rollout
                    |
                    +--> threads::domain / threads::session projections
        |
        +--> runtime task ownership + live trace events
```

Keep transport concerns at the boundary. Agent-loop behavior belongs in
`agent::runtime`; cross-service run orchestration belongs in `agent::bridge`;
durable conversation writes belong in `threads::rollout::store`.

## Persistence map

The backend currently supports related persistence surfaces with different
roles:

| Path | Owner | Role |
| --- | --- | --- |
| `.tinybot/threads/<year>/<month>/<day>/*.jsonl` | `threads::rollout::store` | Canonical append-only Rollouts |
| `.tinybot/state/state.sqlite` | `threads::rollout::store` | Rebuildable discovery and metadata index |

The removed `sessions/sessions.sqlite`, `.tinybot/state/thread-store.jsonl`,
and `.tinybot/threads/threads.sqlite` paths are not compatibility authorities
and must not be reintroduced as fallback or double-write targets.

## Maintenance rules

- Keep Tauri command functions thin; move reusable behavior below the desktop
  boundary.
- Validate capabilities at the service that performs the protected operation.
- Preserve request IDs, trace IDs, run IDs, and client event IDs across layers.
- Append durable conversation state through the Rollout writer; never write
  conversation authority directly to the SQLite index or an in-memory
  projection.
- Surface consistency failures and recovery diagnostics instead of silently
  rebuilding or discarding state.
- Keep external command and payload documentation in
  `docs/api/rust-backend-api.md`; keep implementation invariants next to the
  module that enforces them.
- Update the relevant README when changing module ownership, a persistence
  path, a recovery rule, or the order of a cross-module flow.
