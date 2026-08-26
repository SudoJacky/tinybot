# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:eb622532aef6411ae0f3fde8f62270d48ba916b93ce396141603de18b0f335b6 -->

`agent-graph` owns the framework-independent, versioned Agent Graph definition,
its structural validation, and immutable edit operations. The definition
supports positioned Input, Agent, Router (stored as `condition` for schema
compatibility), and Output nodes plus directed edges. The starter draft
contains the minimal Input-to-Agent-to-Output flow.

The edit interface adds, moves, connects, and removes nodes or edges while
keeping the Input and Output boundaries unique and preventing invalid boundary
edges. Node positions are rounded signed world coordinates, so the domain model
does not impose a viewport boundary on spatial editors. The Input node is a
configuration-free runtime boundary. Agent nodes own an execution workspace
path, additional role instructions, and optional model
settings. The edit interface updates those configurations without exposing
mutable definition state. UI code translates gestures and settings changes
into these operations instead of duplicating topology rules. This module does
not render React, depend on Chat state, perform filesystem I/O, or execute an
Agent Turn. `AgentGraphStore` defines the small list/save/delete persistence
Interface, while `AgentGraphRuntime` starts a saved definition by identity and
exposes Run history. Native storage
and execution remain Adapters at Graph seams rather than implicit dependencies
of the definition model.

The accepted persistence contract keeps a workspace-owned Graph definition
separate from application-owned Graph Runs and canonical Agent Threads. Agent
nodes configure an execution `workspacePath`, node instructions, and
an optional provider/model/reasoning override. Node instructions use the
existing turn-scoped agent-role instruction source, so Tinybot's base and
workspace instructions remain intact. Nodes without a model override inherit
application defaults. `AgentGraphRuntime.start` requires a non-empty input for
each execution and copies that runtime value into the Run record; it is never
part of the saved definition. Legacy persisted Input prompts are discarded when
definitions are loaded or saved. The runtime accepts an acyclic Input-to-Output graph with model-driven Router
branches and reconvergence. Router definitions contain an optional routing
task, at least two stable route IDs with required labels and descriptions, and
an optional provider/model/reasoning override. Every route owns exactly one
outgoing edge through `sourceRouteId`; removing a route prunes its edge. Runtime
preflight rejects cycles, disconnected nodes, incomplete routes, unsupported
non-Router branching, or missing execution workspaces before creating a Run.
See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md)
for the store Interface, revision rules, and runtime boundary.
