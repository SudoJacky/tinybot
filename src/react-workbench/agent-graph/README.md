# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:6ec7e9a2c16199eb0e4ffea0dda5d8d334f286c1ae21905b98175bdd47074a42 -->

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
definition workspace from the shared application workspace registry.
Before a definition is opened, the same workspace command bar serves both the
empty and saved-library states. The empty state previews the starter
Input-to-Agent-to-Output topology; saved definitions render their real nodes
and edges as compact visual cards, with only persisted status and graph counts
shown as metadata.
Each Agent node defaults to that workspace and can select a different execution
workspace. Input and Output remain unique protected boundaries. Input has no
saved task configuration; it receives the value supplied for each Run. A selected
Agent node edits additional role instructions and chooses a currently
available Provider, one of its models, and optional reasoning effort; the
explicit inherit choice leaves model routing to the application defaults.
Router nodes use the same Provider, model, and reasoning controls. They also
configure an optional routing task and two or more labeled routes with required
selection descriptions. Each route renders its own accessible source handle,
while generated `ROUTE_A`, `ROUTE_B`, and later tokens stay runtime-only.
Definition workspace, execution workspace, Provider, model, and reasoning
controls reuse the workbench's canonical `SettingsChoiceList` appearance and
interaction; Graph only owns their placement. Option titles and descriptions
stack inside the narrow node configuration popover so localized copy cannot
collide with the selected-state indicator. The compact Run input reuses the
same field treatment as Router route inputs.
The route lists, explicitly saves, opens, and deletes
workspace definitions through `AgentGraphStore`; dirty state and revision
conflicts stay visible. A separate Run panel accepts the required transient
input, starts only saved definitions, and keeps a compact selectable Run
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
Graph, permits Router branches to reconverge or form bounded controlled loops,
and creates one Run entry per node visit. Node status and Router details use the
latest visit; an Agent re-entry continues its existing Thread so its timeline
contains the complete loop history. Backend preflight rejects non-Router
branching, uncontrolled cycles, disconnected nodes, incomplete route
connections, and missing Agent workspaces.

The page reads workspace choices and display names from `WorkspaceRegistryStore`;
missing folders remain visible but disabled. The selected definition workspace
and each Agent node's execution
workspace belong to Graph state. Graph definitions and Runs use distinct stores,
and each Agent node's first visit creates a parentless standard Thread identified
by `source: "agent_graph"` without routing execution through Chat. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md).
