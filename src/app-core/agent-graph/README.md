# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:26f001a7e97f48d87fa38ecb3f6e384a3f1f25856088e2574211804fd9bf49c6 -->

`agent-graph` owns the framework-independent, versioned Agent Graph definition,
its structural validation, and immutable edit operations. The definition
supports positioned Input, Agent, Condition, and Output nodes plus directed
edges. The starter draft contains the minimal Input-to-Agent-to-Output flow.

The edit interface adds, moves, connects, and removes nodes or edges while
keeping the Input and Output boundaries unique and preventing invalid boundary
edges. Agent nodes own an execution workspace path, and the edit interface
updates that configuration without exposing mutable definition state. UI code
translates gestures and settings changes into these operations instead of
duplicating topology rules. This module does not render React, depend on Chat
state, perform filesystem I/O, or execute an Agent Turn. `AgentGraphStore`
defines the small list/save/delete persistence Interface, while
`AgentGraphRuntime` defines Run history, including the original Run input, and
start operations. Native storage
and execution remain Adapters at Graph seams rather than implicit dependencies
of the definition model.

The accepted persistence contract keeps a workspace-owned Graph definition
separate from application-owned Graph Runs and canonical Agent Threads. Agent
nodes configure an execution `workspacePath`, optional node instructions, and
an optional provider/model/reasoning override. Node instructions use the
existing turn-scoped agent-role instruction source, so Tinybot's base and
workspace instructions remain intact. Nodes without a model override inherit
application defaults. The first runtime accepts
only a single linear Input-to-Output path and rejects Condition nodes, branches,
cycles, disconnected nodes, or missing execution workspaces before creating a
Run. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md)
for the store Interface, revision rules, and runtime boundary.
