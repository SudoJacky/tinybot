# Agent UI Events
<!-- tinybot-module-fingerprint: sha256:c2b36c3f6f0877b48cea2fa7a273a12d5d051a9162aee17b567e51cd60b5dd09 -->

`agent-ui` defines and validates framework-independent Agent UI events, forms,
browser frames, and their projected state.

It accepts untrusted native payloads and enforces schema, field, and unsafe-key
constraints. React rendering and native listener registration belong to the
workbench modules that consume this interface.
