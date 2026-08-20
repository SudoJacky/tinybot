# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:44721f883d3cca6faa70d97dcf3ad8f145e5ce5b6c804754f246dba6872833bf -->

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
defines the small list/save/delete persistence Interface; native storage and
future runtime execution remain Adapters at Graph seams rather than implicit
dependencies of the definition model.

The accepted persistence contract keeps a workspace-owned Graph definition
separate from application-owned Graph Runs and canonical Agent Threads. Agent
nodes currently configure only an execution `workspacePath`; model and runtime
settings continue to inherit application defaults. See
[ADR 0001](../../../docs/decisions/0001-agent-graph-definitions-runs-and-threads.md)
for the store Interface, revision rules, and runtime boundary.
