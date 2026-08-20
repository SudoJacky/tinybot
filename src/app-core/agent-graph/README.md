# Agent Graph Application Core
<!-- tinybot-module-fingerprint: sha256:3e3439dc7a616c0133a3525368b61cfbce27c0bec287ab29ff57c144694f4e92 -->

`agent-graph` owns the framework-independent, versioned Agent Graph definition
and its structural validation. The first definition supports Input, Agent,
Condition, and Output node kinds while the starter draft contains the minimal
Input-to-Agent-to-Output flow.

This module does not render React, depend on Chat state, persist definitions,
or execute an Agent Turn. Persistence and runtime execution remain future
adapters at the Graph interface rather than implicit dependencies of the
definition model.
