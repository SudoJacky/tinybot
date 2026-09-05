# Agent UI Events
<!-- tinybot-module-fingerprint: sha256:f58697567751fe5547c7b9cf9153ec6faba39e30c6575de651b13e88a2d2db32 -->

`agent-ui` defines and validates framework-independent Agent UI form events and
their projected state.

It accepts canonical `agent_ui_event` envelopes from the native bridge and
enforces schema, field, and unsafe-key constraints. Browser snapshots use the
dedicated native browser contract. React rendering and native listener
registration belong to the workbench modules that consume this interface.
