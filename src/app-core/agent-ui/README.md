# Agent UI Events
<!-- tinybot-module-fingerprint: sha256:2cbd95d1c369f96bff8d634ed32b1875b8621f21906fffc25b3736411140c3de -->

`agent-ui` defines and validates framework-independent Agent UI form events and
their projected state.

It accepts canonical `agent_ui_event` envelopes from the native bridge and
enforces schema, field, and unsafe-key constraints. Browser snapshots use the
dedicated native browser contract. React rendering and native listener
registration belong to the workbench modules that consume this interface.
