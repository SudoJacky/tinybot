# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:731da7c61b01357edf598c8c36476f71eb6d11285632ab770afb0a55f6ba323d -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes an unbounded
spatial canvas editor: palette nodes can be dragged or clicked into the canvas,
positioned at signed world coordinates by pointer or keyboard, connected through
accessible handles, selected, and removed with the Delete or Backspace shortcut.
The canvas supports pointer, wheel, and keyboard panning plus bounded zoom controls
in both modes; node drag coordinates remain stable at every zoom level, and the
fit-view control recovers the full graph when nodes have been placed off-screen.
An explicit Edit/View switch separates those editing gestures from
read-only node inspection: clicking a node selects its configuration in Edit
mode, with the configuration panel anchored below or above that node so it
tracks canvas pan and zoom without covering the selection. View mode reuses the
same anchored panel placement for read-only Run status and messages. The route selects a
definition workspace from workspaces already known to Chat and project groups.
Before a definition is opened, the same workspace command bar serves both the
empty and saved-library states. The empty state previews the starter
Input-to-Agent-to-Output topology; saved definitions render their real nodes
and edges as compact visual cards, with only persisted status and graph counts
shown as metadata.
Each Agent node defaults to that workspace and can select a different execution
workspace. Input and Output remain unique protected boundaries. The selected
Input node owns the required initial prompt sent to the first Agent. A selected
Agent node edits additional role instructions and chooses a currently
available Provider, one of its models, and optional reasoning effort; the
explicit inherit choice leaves model routing to the application defaults.
Router nodes use the same Provider, model, and reasoning controls. They also
configure an optional routing task and two or more labeled routes with required
selection descriptions. Each route renders its own accessible source handle,
while generated `ROUTE_A`, `ROUTE_B`, and later tokens stay runtime-only.
Definition workspace, execution workspace, Provider, model, and reasoning
controls reuse the workbench's canonical `SettingsChoiceList` appearance and
interaction; Graph only owns their placement.
The route lists, explicitly saves, opens, and deletes
workspace definitions through `AgentGraphStore`; dirty state and revision
conflicts stay visible. A separate Run panel starts only saved definitions,
without a second transient input field, and keeps a compact selectable Run
history. Activating any canvas node opens a
non-modal node-anchored inspector for that Run: Input and Output show their boundary
content, while Agent nodes load their canonical Thread through the Chat store
and render it with the shared read-only `ChatTimeline`. Router inspection shows
the selected route and the exact model response for that node invocation.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It reuses only Chat's timeline presentation for standard
Graph-owned Threads. It consumes the framework-independent definition in
`app-core/agent-graph`; persistence and execution arrive through
dedicated Graph interfaces. Execution follows one selected path through an
acyclic graph, permits Router branches to reconverge, and creates Run entries
only for nodes actually visited. Backend preflight rejects non-Router
branching, cycles, disconnected nodes, incomplete route connections, and
missing Agent workspaces.

The page may reuse the workspaces already known to Chat and project groups as
choices, but the selected definition workspace and each Agent node's execution
workspace belong to Graph state. Graph definitions and Runs use distinct stores,
and each Agent node creates a parentless standard Thread identified by
`source: "agent_graph"` without routing execution through Chat. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md).
