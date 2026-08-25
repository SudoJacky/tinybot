# React Workbench
<!-- tinybot-module-fingerprint: sha256:cd143fe6b7514b514808aa34218238c0c773fa5d14e7721324b30f84188d6408 -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App` for the main window and selects lightweight
`DesktopPetWindow` and `DesktopPetQuickChatWindow` surfaces for the Windows-only
pet webviews. The quick-chat surface owns an independent renderer service graph
so it remains usable while the main window is minimized.
`DesktopShell` owns the desktop chrome, and `defaultServices.ts` composes the
renderer-facing stores including the optional native pet and quick-chat hosts.

The standalone [`agent-graph/`](agent-graph/README.md) route owns the in-memory
Agent Graph canvas editor without importing `ChatPage` or consuming Chat route
state. It receives the shared stores only to derive definition and per-Agent
execution workspace choices and to consume the dedicated `AgentGraphStore`.
Graph definitions are persisted under the selected workspace while execution
remains outside Chat. The Chat session projection explicitly excludes standard
Threads whose source is `agent_graph`; Graph execution discovers them through
Graph Runs instead. The first Run surface accepts an input, executes a saved
linear Agent path, and keeps a compact Run selector. A node inspector renders
Input and Output boundary content directly and reuses Chat's read-only canonical
timeline for each Agent node's standard Thread.

The optional `hooksStore` backs Settings > Hooks in the native desktop. The
page derives its workspace selector from Chat sessions and project groups,
displays global and workspace definitions plus parse diagnostics, and requires
explicit confirmation before trusting an exact command hash. Its managed form
sends compact drafts and IDs through the store for save, isolated sample test,
recoverable archive, and constrained script-edit operations; filesystem and
execution policy stay in the backend. Hand-written `hooks.json` remains
read-only in the renderer.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- [`sidecar/`](sidecar/README.md) owns the docked resource shell and its Browser,
  Terminal, and Artifact resource presentations.
- [`agent-graph/`](agent-graph/README.md) owns the independent Graph route.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.

The retired TinyOS desktop and its embedded files, terminal, and monitor
applications are not renderer routes. Chat now hosts Sidecar, whose Browser
resources attach directly to the shared native WebView2 session used by Agent
web tools. Terminal resources attach to a separate user-only PTY runtime;
switching or hiding resources preserves the process, while closing the
Terminal tab ends it. Regular chats share the native default-workspace Sidecar
scope even though their Thread metadata has no explicit working directory.
Assistant Markdown file links open contextual Artifact tabs backed by bounded,
Thread-scoped workspace reads. Artifact remains absent from the empty-resource
menu, while binary, truncated, and failed reads stay visible in the preview.
Docked Sidecar widths are measured against the Chat workspace so persisted
sizes and live resizing cannot displace the resource surface beyond its
container; narrow windows retain the overlay gutter instead.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Its diagnostic export method
accepts no page parameters: the service owns renderer-log, locale, time-zone,
and diagnostic-mode collection before delegating ZIP creation to native code.
The main renderer passes one startup trace through `App` into this service
graph, recording React commit, first frame, native event registration, and
session restoration (including fetched page and session counts) before merging
those timings into the native snapshot. Loading or exporting performance
diagnostics does not wait for Chat initialization, so a slow session restore
cannot make its own diagnostics unavailable.
Browser-only runs retain the same service shape but surface native-runtime
unavailability explicitly.

Native Chat submission failures reload the canonical timeline before emitting
the renderer error. This projects a backend-persisted failed Turn immediately
instead of leaving the optimistic active state visible until restart.
