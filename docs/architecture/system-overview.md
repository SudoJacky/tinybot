# System Overview
<!-- tinybot-doc-watch:
src-tauri/README.md
src-tauri/src/agent/bridge/README.md
src-tauri/src/agent/runtime/README.md
src-tauri/src/desktop/README.md
src-tauri/src/runtime/README.md
src-tauri/src/threads/domain/README.md
src-tauri/src/threads/rollout/store/README.md
src/app-core/agent-graph/README.md
src/app-core/chat/README.md
src/app-core/native/README.md
src/react-workbench/README.md
src/react-workbench/agent-graph/README.md
src/react-workbench/sidecar/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:f862e32c5ca07e37020e08ed285a6bef6bc47cd6b9657447224f8b633cac9d90 -->

Tinybot Desktop is a local-first React and Rust application. The renderer owns
presentation, the application core owns framework-independent UI contracts,
and the Rust backend owns native capabilities, Agent execution, durable
conversation state, and process lifecycle.

## System map

```text
React Workbench
    |
    | consumes route-facing interfaces
    v
Application Core <----> Renderer Adapters
                            |
                            | typed Tauri commands and events
                            v
Desktop Commands / Desktop Host
                            |
          +-----------------+------------------+
          |                 |                  |
          v                 v                  v
    Agent Bridge       Domain Modules     Runtime Services
          |                 |                  |
          v                 v                  v
    Agent Runtime       Rollout Store     live tasks / MCP /
    provider + tools    and projections   shell / browser
```

## Main modules

| Module | Owns | Does not own |
| --- | --- | --- |
| `react-workbench` | React routes, presentation, route state | Native transport or durable domain state |
| `react-workbench/agent-graph` | Standalone Agent Graph editing, workspace selection, Run input/history, and per-node inspection | Chat route state or native execution rules |
| `react-workbench/sidecar` | Resource tabs, scope filtering, and Sidecar presentation | Native Browser or Terminal lifecycle |
| `app-core` | Framework-independent contracts, validation, commands, and projections | React rendering or Tauri invocation |
| `app-core/agent-graph` | Versioned Graph contracts, validation, edit operations, persistence Interface, and runtime Interface | React rendering, native filesystem I/O, or Agent execution |
| `agent_graphs` | Workspace Graph files, schema validation, atomic writes, and exact-byte revisions | Renderer state or Graph execution |
| `graph_runs` | Linear Graph preflight, Run status files, Agent node sequencing, and standard Thread creation | Renderer state, definition editing, or the Agent Loop implementation |
| `app-core/native` | Typed renderer adapters for native commands and events | Product state or backend behavior |
| `desktop_commands` | Thin Tauri input/output adaptation | Reusable domain behavior |
| `desktop_terminal` | User-only Sidecar PTY lifecycle and resource ownership | Agent shell sessions or renderer presentation |
| `agent::bridge` | Complete Turn orchestration and persistence coordination | Provider iteration or the Thread data model |
| `agent::runtime` | Provider-and-tool loop, context, checkpoints, and runtime events | Tauri state or durable-store selection |
| `command_hooks` | Hand-written and managed Hook discovery, managed manifest/script generation and constrained editing, exact definition-and-script trust, bounded command execution, and event output parsing | Agent capability policy or renderer state |
| `threads::domain` | Typed Thread, Turn, and Item behavior | Canonical durable storage |
| `threads::rollout::store` | Canonical append-only conversation storage and reconstruction | Live task ownership |
| `runtime` | Startup, shutdown, live Turn generations, MCP, and metrics | Conversation authority |

## Authority map

- Canonical conversation history: Rollouts under the Tinybot application data
  root.
- Typed in-process conversation projection: `threads::domain`.
- Current execution generation for a Turn: `TurnExecutionRuntime`.
- Runtime model-and-tool history: typed `AgentItem` values inside
  `agent::runtime`.
- Tool metadata and exposure: the backend tool registry.
- Renderer product state: route stores composed through the React workbench
  interfaces.
- Agent Graph definitions: versioned `app-core/agent-graph` values stored under
  `<workspace>/.tinybot/graphs/` through the native `agent_graphs` Adapter.
- Agent Graph Runs: application-owned status files under
  `~/.tinybot/graph-runs/<graph-id>/`. The first runtime executes one linear
  Input-to-Output path and delegates every Agent node to a fresh canonical
  Thread. The Chat projection excludes those `source: "agent_graph"` Threads;
  the Graph node inspector reads an explicitly selected Thread and reuses the
  canonical timeline presentation without turning it into a Chat session.
- Exact frontend/backend command and event shapes: the Rust backend reference.
- Command-hook definitions: additive global/workspace `hooks.json` files and
  Tinybot-managed workspace manifests under `.tinybot/hooks/<id>/hook.json`;
  execution authority remains exact definition-and-script hashes in the global
  hook trust store.
- Sidecar Terminal process ownership: the dedicated desktop terminal runtime;
  Agent shell processes remain owned by the Agent runtime's independent shell
  registry.

An adapter may translate at a seam, but it must not become a second authority.

## Dependency direction

```text
React views -> workbench interfaces -> app-core contracts -> native adapters
                                                        -> Tauri commands
Tauri commands -> bridge / domain modules -> runtime and persistence
agent runtime -> injected provider, tool, checkpoint, cancellation, trace, and command-hook interfaces
```

Keep transport at the outside. Domain modules must not depend on React or
Tauri. The generic Agent Runtime receives adapters through injected interfaces
instead of choosing desktop persistence or transport internally.

## Cross-module flows

- A user message follows the [Agent Turn lifecycle](agent-turn-lifecycle.md).
- Model-visible instructions follow [Context and instructions](context-and-instructions.md).
- Model-requested actions follow [Tool execution and permissions](tool-execution-and-permissions.md).
- Durable conversation state follows [Thread and Rollout persistence](thread-rollout-persistence.md).
- The accepted Agent Graph persistence and execution seams are recorded in
  [Agent Graph definitions, runs, and Threads](../decisions/0001-agent-graph-definitions-runs-and-threads.md).

## Maintainer entry points

- [Rust backend map](../../src-tauri/README.md)
- [React workbench](../../src/react-workbench/README.md)
- [Agent Graph workbench](../../src/react-workbench/agent-graph/README.md)
- [Agent Graph contracts](../../src/app-core/agent-graph/README.md)
- [Sidecar resource shell](../../src/react-workbench/sidecar/README.md)
- [Application core chat contracts](../../src/app-core/chat/README.md)
- [Native renderer adapters](../../src/app-core/native/README.md)
- [Desktop runtime](../../src-tauri/src/desktop/README.md)
- [Native runtime services](../../src-tauri/src/runtime/README.md)
