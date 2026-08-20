# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:fc8bbf8b8989a872989bde9ff774b7df5dbe9671dd754ba078d9f4420e08960e -->

`agent-graph` owns the framework-independent, versioned Agent Graph definition,
its structural validation, and immutable edit operations. The definition
supports positioned Input, Agent, Condition, and Output nodes plus directed
edges. The starter draft contains the minimal Input-to-Agent-to-Output flow.

The edit interface adds, moves, connects, and removes nodes while keeping the
Input and Output boundaries unique and preventing invalid boundary edges. UI
code translates gestures into these operations instead of duplicating topology
rules. This module does not render React, depend on Chat state, persist
definitions, or execute an Agent Turn. Persistence and runtime execution remain
future adapters at the Graph interface rather than implicit dependencies of the
definition model.
