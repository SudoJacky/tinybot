# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:f3f3d2fbef34473d9095ec3381c802f0d1ead75ba86b7db56e5527fe29a92e23 -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes a small canvas
editor: palette nodes can be dragged or clicked into the canvas, positioned by
pointer or keyboard, connected through accessible handles, selected, and
removed. The route selects a definition workspace from workspaces already known
to Chat and project groups. Each Agent node defaults to that workspace and can
select a different execution workspace. Input and Output remain unique
protected boundaries. The route lists, explicitly saves, opens, and deletes
workspace definitions through `AgentGraphStore`; dirty state and revision
conflicts stay visible. Runtime execution is not implemented yet.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It consumes the framework-independent definition in
`app-core/agent-graph`; persistence and future execution arrive through
dedicated Graph interfaces.

The page may reuse the workspaces already known to Chat and project groups as
choices, but the selected definition workspace and each Agent node's execution
workspace belong to Graph state. The Graph store is now implemented; the
accepted design adds a separate Graph Run surface without routing execution
through Chat. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md).
