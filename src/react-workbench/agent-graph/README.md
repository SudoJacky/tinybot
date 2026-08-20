# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:c717b126b8ea811932d4b0e237be55a6325a08c6ed4f37615bb2de13ffbdb210 -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes a small canvas
editor: palette nodes can be dragged or clicked into the canvas, positioned by
pointer or keyboard, connected through accessible handles, selected, and
removed. The route selects a definition workspace from workspaces already known
to Chat and project groups. Each Agent node defaults to that workspace and can
select a different execution workspace. Input and Output remain unique
protected boundaries. The route lists, explicitly saves, opens, and deletes
workspace definitions through `AgentGraphStore`; dirty state and revision
conflicts stay visible. A separate Run panel starts only saved definitions and
keeps a compact selectable Run history. Activating any canvas node opens a
non-modal right drawer for that Run: Input and Output show their boundary
content, while Agent nodes load their canonical Thread through the Chat store
and render it with the shared read-only `ChatTimeline`.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It reuses only Chat's timeline presentation for standard
Graph-owned Threads. It consumes the framework-independent definition in
`app-core/agent-graph`; persistence and execution arrive through
dedicated Graph interfaces. The first execution slice supports only one linear
Input-to-Output path; backend preflight visibly rejects Condition nodes,
branches, cycles, disconnected nodes, and missing Agent workspaces.

The page may reuse the workspaces already known to Chat and project groups as
choices, but the selected definition workspace and each Agent node's execution
workspace belong to Graph state. Graph definitions and Runs use distinct stores,
and each Agent node creates a parentless standard Thread identified by
`source: "agent_graph"` without routing execution through Chat. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md).
