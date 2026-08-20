# React Workbench
<!-- tinybot-module-fingerprint: sha256:fdfaceb558c0559e1fe83f6ae4b3803202804bfe08297e83ff200fa4f80daa4b -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

The standalone [`agent-graph/`](agent-graph/README.md) route owns the in-memory
Agent Graph canvas editor without importing `ChatPage` or consuming Chat route
state. It receives the shared stores only to derive definition and per-Agent
execution workspace choices and to consume the dedicated `AgentGraphStore`.
Graph definitions are persisted under the selected workspace while execution
remains outside Chat. The Chat session projection explicitly excludes standard
Threads whose source is `agent_graph`; Graph execution discovers them through
Graph Runs instead.

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
Docked Sidecar widths are measured against the Chat workspace so persisted
sizes and live resizing cannot displace the resource surface beyond its
container; narrow windows retain the overlay gutter instead.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Its diagnostic export method
accepts no page parameters: the service owns renderer-log, locale, time-zone,
and diagnostic-mode collection before delegating ZIP creation to native code.
Browser-only runs retain the same service shape but surface native-runtime
unavailability explicitly.
