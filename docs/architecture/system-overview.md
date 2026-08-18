# System Overview
<!-- tinybot-doc-watch:
src-tauri/README.md
src-tauri/src/agent/bridge/README.md
src-tauri/src/agent/runtime/README.md
src-tauri/src/desktop/README.md
src-tauri/src/runtime/README.md
src-tauri/src/threads/domain/README.md
src-tauri/src/threads/rollout/store/README.md
src/app-core/chat/README.md
src/app-core/native/README.md
src/react-workbench/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:8ad4d88956133d6559edb415eef60e9de175ab50b29e610dcf0947c025fa0217 -->

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
| `app-core` | Framework-independent contracts, validation, commands, and projections | React rendering or Tauri invocation |
| `app-core/native` | Typed renderer adapters for native commands and events | Product state or backend behavior |
| `desktop_commands` | Thin Tauri input/output adaptation | Reusable domain behavior |
| `agent::bridge` | Complete Turn orchestration and persistence coordination | Provider iteration or the Thread data model |
| `agent::runtime` | Provider-and-tool loop, context, checkpoints, and runtime events | Tauri state or durable-store selection |
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
- Exact frontend/backend command and event shapes: the Rust backend reference.

An adapter may translate at a seam, but it must not become a second authority.

## Dependency direction

```text
React views -> workbench interfaces -> app-core contracts -> native adapters
                                                        -> Tauri commands
Tauri commands -> bridge / domain modules -> runtime and persistence
agent runtime -> injected provider, tool, checkpoint, cancellation, and trace interfaces
```

Keep transport at the outside. Domain modules must not depend on React or
Tauri. The generic Agent Runtime receives adapters through injected interfaces
instead of choosing desktop persistence or transport internally.

## Cross-module flows

- A user message follows the [Agent Turn lifecycle](agent-turn-lifecycle.md).
- Model-visible instructions follow [Context and instructions](context-and-instructions.md).
- Model-requested actions follow [Tool execution and permissions](tool-execution-and-permissions.md).
- Durable conversation state follows [Thread and Rollout persistence](thread-rollout-persistence.md).

## Maintainer entry points

- [Rust backend map](../../src-tauri/README.md)
- [React workbench](../../src/react-workbench/README.md)
- [Application core chat contracts](../../src/app-core/chat/README.md)
- [Native renderer adapters](../../src/app-core/native/README.md)
- [Desktop runtime](../../src-tauri/src/desktop/README.md)
- [Native runtime services](../../src-tauri/src/runtime/README.md)
