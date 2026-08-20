# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:f6f0a388c2bd6c2e1ab88a54e9bae7c0736a771e55d6b03c96f7add9137eab4c -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes a small canvas
editor: palette nodes can be dragged or clicked into the canvas, positioned by
pointer or keyboard, connected through accessible handles, selected, and
removed. The route selects a definition workspace from workspaces already known
to Chat and project groups. Each Agent node defaults to that workspace and can
select a different execution workspace. Input and Output remain unique
protected boundaries. Structural validation stays visible without pretending
that workspace persistence or runtime execution already exists.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It consumes the framework-independent definition in
`app-core/agent-graph`; future persistence and execution should arrive through
dedicated Graph interfaces.

The page may reuse the workspaces already known to Chat and project groups as
choices, but the selected definition workspace and each Agent node's execution
workspace belong to Graph state. The accepted design adds a dedicated Graph
store and Graph Run surface without routing execution through Chat. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md).
