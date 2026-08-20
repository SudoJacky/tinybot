# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:99605adde0079c4e909673502bdeb8f4a0272744fe47fe05d9184b0aaa574083 -->

`agent-graph` owns the framework-independent, versioned Agent Graph definition,
its structural validation, and immutable edit operations. The definition
supports positioned Input, Agent, Condition, and Output nodes plus directed
edges. The starter draft contains the minimal Input-to-Agent-to-Output flow.

The edit interface adds, moves, connects, and removes nodes or edges while
keeping the Input and Output boundaries unique and preventing invalid boundary
edges. UI code translates gestures into these operations instead of duplicating
topology rules. This module does not render React, depend on Chat state, persist
definitions, or execute an Agent Turn. Persistence and runtime execution remain
future adapters at the Graph interface rather than implicit dependencies of the
definition model.
