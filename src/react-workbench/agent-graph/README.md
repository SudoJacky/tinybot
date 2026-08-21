# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:f4116a186fb87c4d322c0e20ef7ad11d9efaf56f2c8cc9129216214504ae06bf -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes a small canvas
editor: palette nodes can be dragged or clicked into the canvas, positioned by
pointer or keyboard, connected through accessible handles, selected, and
removed with the Delete or Backspace shortcut. The canvas supports pointer,
wheel, and keyboard panning plus bounded zoom controls in both modes; node drag
coordinates remain stable at every zoom level. An explicit Edit/View switch separates those editing gestures from
read-only node inspection: clicking a node selects its configuration in Edit
mode, with the configuration panel anchored below or above that node so it
tracks canvas pan and zoom without covering the selection. View mode reuses the
same anchored panel placement for read-only Run status and messages. The route selects a
definition workspace from workspaces already known to Chat and project groups.
Each Agent node defaults to that workspace and can select a different execution
workspace. Input and Output remain unique protected boundaries. The selected
Input node owns the required initial prompt sent to the first Agent. A selected
Agent node edits additional role
instructions and chooses a configured model plus optional reasoning effort;
the explicit inherit choice leaves model routing to the application defaults.
The route lists, explicitly saves, opens, and deletes
workspace definitions through `AgentGraphStore`; dirty state and revision
conflicts stay visible. A separate Run panel starts only saved definitions,
without a second transient input field, and keeps a compact selectable Run
history. Activating any canvas node opens a
non-modal node-anchored inspector for that Run: Input and Output show their boundary
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
