# Tinybot Rust Backend
<!-- tinybot-module-fingerprint: sha256:2ae20b0763118342f3b4f26697fe922680f3111ca239b68c5f62cfe43a5abd72 -->

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
  commands; `src/desktop_terminal.rs` owns the user-only Sidecar PTY runtime;
  `src/desktop/diagnostics.rs` owns bounded Performance Trace snapshots and
  local diagnostic ZIP export; `src/desktop/pet.rs` creates the Windows-only
  transparent desktop-pet window and its adjacent quick-chat panel without
  making either an owned child of `main`; `src/desktop/pet_file_drop.rs` owns
  the WebView2 local-file bridge used by the pet.

Sidecar terminals with no explicit Thread working directory resolve through
the same configured native backend workspace used by ordinary Agent turns.
Contextual Artifact file previews instead resolve the canonical Thread's
recorded working directory and pass only a guarded, bounded file-chunk result
to the renderer; the renderer cannot select an arbitrary workspace root.
- `src/desktop_commands/` adapts typed Tauri inputs to backend services.
- `WorkerRpcRouter` handles versioned `WorkerRequest` values for internal and
  transport-backed callers.
- Tauri events carry live agent, timeline, approval, and runtime updates to the
  native workbench.

The default desktop path is in-process. Compatibility fields may mention HTTP
or WebSocket endpoints, but they do not imply that the Tauri backend binds a
local server.

Tauri capabilities remain window-scoped. `capabilities/default.json` belongs
to the main webview, while `capabilities/desktop-pet.json` grants the pet only
event, position, native drag operations, and its no-op file-drop signal on
Windows. The separate
`capabilities/desktop-pet-chat.json` grants the quick-chat panel scoped events,
window hiding, native dragging, and only the application commands required to
pick attachments and list, create, configure, and run chat Threads.
`app_commands.rs` is the
build-time application-command manifest; `permissions/app-commands.toml`
separates the complete main-window command surface from the narrow pet and
quick-chat subsets.
The main capability also grants restore and focus operations so quick-chat
handoff can bring a minimized main window to the foreground before routing to
the selected Thread.

## Domain terminology

Use these terms consistently in backend code and documentation:

- **Thread** is the durable conversation container. It owns ordered Turns and
  their Items, survives process restarts and connection changes, and may carry
  an optional long-lived goal. A goal is metadata on a Thread, not the
  definition of a Thread.
- **Turn** starts with one user request and includes all agent work that follows
  until the Turn completes, fails, is interrupted, or waits for typed user
  input. Provider iterations, reasoning, tool calls and results, and form
  continuations all belong to the same Turn.
- **Item** is one ordered input or output within a Turn, such as a user message,
  agent message, reasoning entry, tool call, tool result, or approval request.
  Not every Item is a model-visible message. Every durable Item has its own
  stable, type-prefixed identity, such as `msg_*`, `rs_*`, `ctc_*`, or
  `ctco_*`.
- **Message** is conversational content projected into model history. Message
  is narrower than Item and must not be used as a generic name for runtime
  events, approvals, or persistence records.
- **Agent loop** is the internal Turn execution algorithm that repeats Provider
  and tool iterations until the Turn waits for typed user input or reaches a
  terminal state. It is not a separate durable conversation identity.
- **TurnExecution** is the process-local object currently advancing a Turn. It
  is addressed by `turnId`; an internal generation prevents obsolete tasks from
  publishing late results. It is not a separate durable conversation identity.
- **Connection** and **process** are ephemeral execution infrastructure. A
  Thread can be loaded and advanced across multiple connections and backend
  process lifetimes.
- **Rollout** is the canonical append-only durable record from which Thread,
  Turn, Item, and runtime projections are reconstructed.

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
   - `lib.rs`, `desktop_commands/`, `desktop_terminal.rs`, `desktop/files.rs`,
     and the desktop menu, logging, update, and heartbeat modules.
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
   - [`command_hooks/`](src/command_hooks/README.md) discovers and runs trusted
     user commands for selected Agent lifecycle stages.
4. **Conversation domain and persistence**
   - [`threads/domain/`](src/threads/domain/README.md) owns typed Thread state
     and in-process projections.
   - `threads/rollout/format/` owns typed, versioned Rollout lines and pure
     reconstruction.
   - [`threads/rollout/store/`](src/threads/rollout/store/README.md) owns
     canonical append-only Rollouts and their process-local Thread index.
5. **Domain services**
   - `workspace/`, `workspace_extensions.rs`, `tools/`, `automation/`, `collaboration/`, `config/`,
     `agent_graphs.rs`, `graph_runs.rs`, `project_groups.rs`, `plugins/`,
     `skills/`, and `memory/` own their business rules and do not depend on RPC
     or Tauri.
   - `workspace_extensions.rs` discovers project-local `.agents/skills` and
     supported MCP configuration files from the effective working-directory
     hierarchy, normalizing them for one Turn without mutating saved global
     configuration.
6. **Process and transport infrastructure**
   - [`runtime/`](src/runtime/README.md) owns live tasks, shared MCP state,
     startup recovery, shutdown, and operational metrics.
   - `transport/stdio_worker/` contains the capability-checked diagnostics
     endpoint retained by the RPC router. The desktop runtime itself is
     in-process.
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
                    +--> threads::domain projections
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
| `~/.tinybot/threads/<year>/<month>/<day>/thread-*.jsonl[.zst]` | `threads::rollout::store` | Active canonical Rollouts |
| `~/.tinybot/archived_threads/<year>/<month>/<day>/thread-*.jsonl[.zst]` | `threads::rollout::store` | Archived canonical Rollouts |
| `~/.tinybot/project-groups.json` | `project_groups` | Named groups and their workspace memberships |
| `~/.tinybot/chat-attachments/images/<sha256>.<ext>` | `chat_attachments` | Content-addressed local image copies referenced by durable chat messages and encoded only while building provider requests |
| `<workspace>/.tinybot/graphs/<graph-id>.json` | `agent_graphs` | Versioned Agent Graph definitions |
| `~/.tinybot/graph-runs/<graph-id>/<run-id>.json` | `graph_runs` | Runtime input, execution, output, and node-to-Thread status |
| `~/.tinybot/hooks.json` | `command_hooks` | Global user command-hook definitions |
| `~/.tinybot/hook-trust.json` | `command_hooks` | Trusted exact-definition hashes |
| `<workspace>/.tinybot/hooks.json` | `command_hooks` | Workspace-scoped command-hook definitions |

Thread metadata, checkpoint pointers, and Rollout heads are rebuilt into a
process-local index from the Rollouts. Project-group membership is loaded from
its own atomic JSON store and authorizes coordinator-created workspace Threads.
Agent Graph definitions use one atomically replaced JSON file per Graph and an
exact-byte SHA-256 revision for optimistic saves and deletes. Agent nodes may
store additional role instructions plus a provider/model/reasoning override;
the Graph runtime maps them onto the existing Turn instruction and settings
interfaces, while omitted overrides inherit application defaults. The Input
node has no saved configuration; Run start requires a non-empty transient input
and records that exact value on the Run. Legacy Input prompts are ignored and
removed on the next save.
Graph Runs use separate atomically replaced status files. The first visit to an
Agent node creates a canonical parentless Thread with `source: "agent_graph"`;
later visits in the same Run continue that Thread with the preceding node's
output. Its Rollout remains under the standard Thread root. Router nodes instead
make one non-streaming, tool-free model request with a dedicated routing prompt,
strictly parse an exact generated route token, and persist the selected stable
route ID without creating a Thread. Router-controlled loops require an exit
route and are bounded to 64 Agent or Router executions per Run.

For a Chat Thread with an explicitly declared working directory, the tool
registry adds only Graphs stored in that same definition workspace. The global
backend-workspace fallback does not expose Graph tools. Each Graph is a Deferred
tool bound to its workspace, ID, and revision; the model supplies only the Run
input. A selected tool waits for the Graph Run and projects its final output
through the standard parent Turn tool-result path. Graph-created Agent Threads
do not receive Graph tools, preventing nested or recursive Graph execution.
Tool discovery skips invalid Graph files and emits a path-specific diagnostic,
so one stale definition cannot abort an unrelated Chat Turn; Graph management
listing remains strict so invalid saved definitions are not hidden.

Desktop startup moves canonical Rollouts from the former
`<workspace>/.tinybot/{threads,archived_threads}` layout into the application
data root without overwriting conflicts, then rebuilds the in-memory index.

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
conversation authority directly to SQLite or an in-memory
  projection.
- Surface consistency failures and recovery diagnostics instead of silently
  rebuilding or discarding state.
- Keep external command and payload documentation in `docs/api/`; keep
  implementation invariants next to the module that enforces them.
- Update the relevant README when changing module ownership, a persistence
  path, a recovery rule, or the order of a cross-module flow.
