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
src/app-core/desktop-pet/README.md
src/app-core/native/README.md
src/react-workbench/README.md
src/react-workbench/agent-graph/README.md
src/react-workbench/shell/README.md
src/react-workbench/sidecar/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:8426ee6d08b416f7c062432a571d449ad1b47e361a94af8d1e13d0fcfac90dc2 -->

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
| `react-workbench` | React routes, presentation, route state, and shared menu-popover primitives | Native transport or durable domain state |
| `react-workbench/agent-graph` | Standalone Agent Graph library and unbounded spatial canvas, node configuration, Run history, and per-node inspection | Chat route state or native execution rules |
| `react-workbench/sidecar` | Resource tabs, scope filtering, and Browser, Terminal, or contextual Artifact presentation | Native Browser or Terminal lifecycle, Artifact domain state, or workspace file authorization |
| `app-core` | Framework-independent contracts, validation, commands, and projections | React rendering or Tauri invocation |
| `app-core/agent-graph` | Versioned Graph contracts, validation, edit operations, persistence Interface, and runtime Interface | React rendering, native filesystem I/O, or Agent execution |
| `app-core/desktop-pet` | Pet preferences plus monitor-aware pet and quick-chat window geometry | React rendering or native window calls |
| `agent_graphs` | Workspace Graph files, schema validation, atomic writes, and exact-byte revisions | Renderer state or Graph execution |
| `graph_runs` | Linear Graph preflight, Run status files, Agent node sequencing, and standard Thread creation | Renderer state, definition editing, or the Agent Loop implementation |
| `app-core/native` | Typed renderer adapters for native commands and events | Product state or backend behavior |
| `desktop_commands` | Thin Tauri input/output adaptation, including Thread-scoped workspace selection for Artifact file reads | Reusable workspace path validation or file-reading behavior |
| `desktop/memory_metrics` | Windows Rust-host and shared WebView2 process memory collection with deduplicated process totals | Long-term profiling history or renderer presentation |
| `desktop/pet_file_drop` and `desktop/files` | Windows WebView2 dropped-path extraction plus shared chat-attachment validation/import | Chat state, file-byte transport, or renderer presentation |
| `desktop_terminal` | User-only Sidecar PTY lifecycle and resource ownership | Agent shell sessions or renderer presentation |
| `chat_attachments` | Content-addressed managed image storage, validation, and request-local Data URL encoding | Conversation authority or provider protocol selection |
| `workspace_extensions` | Project-local `.agents/skills`, `.codex/skills`, and supported MCP configuration discovery for an effective working directory | Global plugin installation or saved configuration mutation |
| `workspace_registry` | The application workspace catalog, portable canonical paths, display names, and atomic `workspaces.json` persistence | Thread history, project membership, or filesystem folder lifecycle |
| `agent::bridge` | Complete Turn orchestration and persistence coordination | Provider iteration or the Thread data model |
| `agent::runtime` | Provider-and-tool loop, context, checkpoints, and runtime events | Tauri state or durable-store selection |
| `command_hooks` | Hand-written and managed Hook discovery, managed manifest/script generation and constrained editing, exact definition-and-script trust, bounded command execution, and event output parsing | Agent capability policy or renderer state |
| `config` | Schema migration, validated application settings, secret-safe projections, and atomic persistence | Provider inference or renderer-owned defaults |
| `threads::domain` | Typed Thread, Turn, and Item behavior | Canonical durable storage |
| `threads::rollout::store` | Canonical append-only conversation storage and reconstruction | Live task ownership |
| `runtime` | Startup, shutdown, live Turn generations, MCP, and metrics | Conversation authority |

## Authority map

- Canonical conversation history: Rollouts under the Tinybot application data
  root. Startup index, Thread projection, and Turn recovery readers reuse a
  bounded Rollout-head-keyed cache; an append invalidates the matching cached
  content on its next access without changing Rollout authority.
- Application configuration: schema v2 `~/.tinybot/config.json`. The Rust
  Config store is the migration boundary and retains one pre-migration
  `config.json.v1.bak`; Provider routing requires an explicit Provider or
  active Profile and is never inferred from a model name.
- Global MCP definitions share that configuration authority. The renderer
  reads secret-safe editable projections and sends field-level settings patches;
  native configuration and runtime services retain secret, process, and
  transport ownership. Saving a definition marks the Tools & Plugins catalog
  for an explicit restart, while enabled-state changes apply immediately and
  then refresh discovery. A refresh keeps the last catalog visible until the
  native runtime reports the replacement snapshot or a visible failure.
- Managed chat image bytes: content-addressed files under
  `~/.tinybot/chat-attachments/images/`; Rollouts remain authoritative for the
  typed reference and never persist the Base64 request payload.
- Typed in-process conversation projection: `threads::domain`.
- Daily provider/model token totals: `~/.tinybot/state/token-usage.sqlite`,
  derived only from calls that report provider usage. It is aggregate telemetry,
  not conversation authority.
- Current execution generation for a Turn: `TurnExecutionRuntime`.
- Process-local performance diagnostics: the native runtime metric/event ring,
  augmented with the renderer's bounded startup trace and bounded Rust/WebView2
  memory samples at the workbench seam. JSON snapshots and diagnostic bundles
  are saved locally through native file dialogs and are never uploaded
  automatically.
- Runtime model-and-tool history: typed `AgentItem` values inside
  `agent::runtime`.
- Tool metadata and exposure: the backend tool registry.
- Renderer product state: route stores composed through the React workbench
  interfaces.
- Imported workspace catalog: `~/.tinybot/workspaces.json`, owned by the Rust
  `WorkspaceRegistry`. Register, rename, and forget are the only catalog write
  operations. Register canonicalizes an existing directory and removes Windows
  verbatim `\\?\` and `\\?\UNC\` prefixes before persistence or renderer output.
  Existing Thread working directories and project memberships are imported once
  when upgrading from the pre-registry model; the persisted migration marker
  prevents subsequent workspace reads from scanning Thread history. Forgetting
  removes only the catalog record and is rejected while a project group still
  references the workspace; it never deletes or moves the directory. The Tools
  & Plugins Skill inventory reads this complete catalog, while Chat's slash
  menu continues to discover only global and active-workspace Skills.
- Chat startup selection: `DesktopShell` marks only the first Chat mount in a
  desktop app lifetime as an uncreated conversation. Persisted tab state may be
  reused by later route remounts in that same lifetime, but it is not the app
  launch selection authority. User new-chat commands create renderer-owned draft
  sessions; only drafts with composer text survive navigation, and the first
  send replaces the draft with a canonical Thread before dispatching its Turn.
  After that Turn is durable, an independent tool-free request may refine the
  optimistic first-prompt title without delaying the Turn or overriding a later
  manual rename. It reuses that Turn's effective Provider request settings and
  response decoder while replacing the prompt and omitting tools and history;
  only final assistant text can become the title.
  Chat reports its active persisted session or local draft working directory to
  the shell as transient cross-route context; workspace-scoped resource routes
  consume that projection without deriving a current workspace from recency.
- Agent Graph definitions: versioned `app-core/agent-graph` values stored under
  `<workspace>/.tinybot/graphs/` through the native `agent_graphs` Adapter.
  Node positions are signed world coordinates; viewport pan, zoom, and fit-to-view
  behavior remain renderer presentation state rather than persistence constraints.
- Agent Graph Runs: application-owned status files under
  `~/.tinybot/graph-runs/<graph-id>/`. The runtime follows one model-selected
  path through a Router graph, receives the initial task at Run time, and
  permits Router-controlled loops with an exit route under a 64-node-execution
  budget. The first visit to an Agent node creates a canonical Thread; later
  visits in the same Run continue it. Per-node role
  instructions and optional Provider, model, and reasoning-effort settings use
  the existing Turn interfaces; the renderer only offers profile-enabled models
  from available Provider connections and carries their image-input capability,
  while absent settings inherit application defaults.
  Router decisions use a separate, single-shot, tool-free provider request and
  do not create Threads or load Agent instruction sources.
  Ordinary Chat Turns expose Graphs from their exact working directory as
  deferred tools; each call binds the saved Graph identity and returns the
  completed Run's final output. Graph-created Turns do not expose Graph tools.
  The Chat projection excludes those `source: "agent_graph"` Threads;
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
- Panel exit animation is renderer-only presentation. Closing disables input
  and hides native browser surfaces immediately; retained React content may
  finish its CSS transition without extending native resource ownership or
  adding persistent animation state.
- Desktop process residency: the Rust desktop host owns the system tray and
  main-window lifecycle. Closing `main` hides that window while the Native
  Runtime and auxiliary pet windows remain active; only the explicit tray exit
  command starts bounded browser, terminal, and Agent-runtime cleanup before
  process exit.
- Desktop pet preferences: the main renderer's `DesktopShell`, persisted under
  `tinybot.ui.desktop-pet.v2`. Legacy `v1` visibility and size migrate without
  carrying viewport-relative coordinates into the physical desktop coordinate
  system. The Windows `desktop-pet` webview is a projection of that state and
  never becomes a second authority.
- Desktop pet quick-chat state: canonical Threads and Rollouts remain
  authoritative. The `desktop-pet-chat` webview owns only its editable draft,
  removable attachment selection, selected recent Thread, and shared
  composer/timeline projection. The native `pet_file_drop` Adapter extracts
  local paths from WebView2 additional objects, while the shared attachment
  importer owns validation and managed-image storage; explicit Tauri events
  carry versioned draft-and-attachment presentation and main-window Thread
  activation.

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

The renderer entry point has three surfaces. The main window follows
`main.tsx -> App -> DesktopShell` and composes the application services. The
initial HTML owns a white, centered-logo startup surface; the main window
dismisses it after its first React frame, with reduced-motion support. The
small `src/main.ts` bootstrap loads the workbench asynchronously and displays
renderer diagnostics if that import fails. Startup presentation does not gate
native session restoration and is hidden for both pet surfaces. The
Windows-only `?surface=desktop-pet` path mounts `DesktopPetWindow` directly
under the shared language, appearance, error, and diagnostic providers. It
receives snapshots from `DesktopShell` through `app-core/native`, so showing a
global desktop pet does not duplicate routes, stores, or native runtimes. The
`?surface=desktop-pet-chat` path mounts `DesktopPetQuickChatWindow` with a
bounded service composition and a least-privilege Tauri command permission so
it can pick attachments and create and continue canonical Threads; the scoped
native event seam positions it next to the pet and hands an explicit Thread ID
back to `DesktopShell` when the user opens the conversation in the main Chat
route. Hiding the main window in the system tray does not remount these
surfaces or transfer their state authority; restoring `main` focuses the
existing application window.

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
