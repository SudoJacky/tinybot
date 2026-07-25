# Tinybot Rust Backend

This single crate is the native backend for Tinybot Desktop. It owns the
in-process Tauri host, the native agent runtime, RPC services, runtime
lifecycle, and workspace-backed persistence used by the desktop workbench.

This README is a maintainer map. For frontend-facing command and payload
details, see [the Rust backend API reference](../docs/api/rust-backend-api.md).
For desktop setup and launch behavior, see [the desktop guide](../docs/desktop.md).

## Entry points

- `src/main.rs` starts the Tauri application through `tinybot_desktop_lib::run`.
- `src/lib.rs` delegates application startup to `desktop::run`.
- `src/desktop/bootstrap.rs` assembles shared runtime state and registers Tauri
  commands.
- `src/desktop_commands/` adapts typed Tauri inputs to backend services.
- `WorkerRpcRouter` handles versioned `WorkerRequest` values for internal and
  transport-backed callers.
- Tauri events carry live agent, timeline, approval, and runtime updates to the
  native workbench.

The default desktop path is in-process. Compatibility fields may mention HTTP
or WebSocket endpoints, but they do not imply that the Tauri backend binds a
local server.

## Domain terminology

Use these terms consistently in backend code and documentation:

- **Thread** is the durable conversation container. It owns ordered Turns and
  their Items, survives process restarts and connection changes, and may carry
  an optional long-lived goal. A goal is metadata on a Thread, not the
  definition of a Thread.
- **Turn** starts with one user request and includes all agent work that follows
  until the Turn completes, fails, or is interrupted. Provider iterations,
  reasoning, tool calls and results, and approval or form pauses all belong to
  the same Turn. Resuming a pause does not create a new Turn.
- **Item** is one ordered input or output within a Turn, such as a user message,
  agent message, reasoning entry, tool call, tool result, or approval request.
  Not every Item is a model-visible message. Every durable Item has its own
  stable, type-prefixed identity, such as `msg_*`, `rs_*`, `ctc_*`, or
  `ctco_*`.
- **Message** is conversational content projected into model history. Message
  is narrower than Item and must not be used as a generic name for runtime
  events, approvals, or persistence records.
- **Agent loop** is the internal Turn execution algorithm that repeats Provider
  and tool iterations until the Turn pauses or reaches a terminal state. It is
  not a separate durable conversation identity.
- **TurnExecution** is the process-local object currently advancing a Turn. It
  is addressed by `turnId`; an internal generation prevents obsolete tasks from
  publishing late results. It is not a separate durable conversation identity.
- **Connection** and **process** are ephemeral execution infrastructure. A
  Thread can be loaded and advanced across multiple connections and backend
  process lifetimes.
- **Session** is retained only where an existing compatibility contract exposes
  a session-shaped projection of canonical Thread Rollouts. It is not a second
  durable conversation model and must not be used as a synonym for Thread,
  Connection, Process, Turn, or TurnExecution.
- **Rollout** is the canonical append-only durable record from which Thread,
  Turn, Item, runtime, and compatibility projections are reconstructed.

The core ownership hierarchy is:

```text
Thread
  +-- Turn
        +-- Item
```

Execution infrastructure loads and advances this hierarchy but does not own it:

```text
Process / Connection
        |
        +-- load or resume Thread
                  |
                  +-- execute Turn through the Agent loop
```

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
   - [`agent/runtime/`](src/agent/runtime/README.md) implements the Agent Turn
     loop independently of the Tauri command surface.
   - [`agent/bridge/`](src/agent/bridge/README.md) adapts Thread history,
     instructions, tools, trace sinks, checkpoints, and persistence to a
     complete Turn execution.
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
        +--> agent::runtime --> Agent Turn loop --> provider + injected tools
        |
        +--> threads::rollout::store canonical Rollout
                    |
                    +--> threads::domain / threads::session projections
        |
        +--> runtime task ownership + live trace events
```

Keep transport concerns at the boundary. Agent-loop and Turn lifecycle behavior
belong in `agent::runtime`; adapting Thread-owned resources belongs in
`agent::bridge`; durable conversation writes belong in
`threads::rollout::store`.

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

## Test layout

- Unit tests that require private implementation access live beside their
  owner in `*_tests.rs` or a `tests/` subdirectory. Production modules include
  them only under `#[cfg(test)]`.
- Crate-wide RPC, persistence, lifecycle, and complete Turn-flow tests live in
  `tests/crate/`. `src/lib.rs` includes this suite as a test-only module so it
  can exercise private boundaries without widening the production API.
- Run `npm run analyze:rust` from the repository root to regenerate Rust
  metrics under `src-tauri/target/code-analysis`. The command excludes
  `**/tests/**` and `**/*_tests.rs`.

## Maintenance rules

- Keep Tauri command functions thin; move reusable behavior below the desktop
  boundary.
- Validate capabilities at the service that performs the protected operation.
- Preserve Thread, Turn, Item, request, trace, tool-call, and client-event IDs
  across layers. Do not introduce a second Run identity for a Turn.
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
