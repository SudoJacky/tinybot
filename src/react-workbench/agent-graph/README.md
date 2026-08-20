# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:173a28032e9fa9ce06034abd6f9ce0d2475f35d9b33bd17377269b321517b2fa -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The page creates one honest in-memory starter draft and exposes a small canvas
editor: palette nodes can be dragged or clicked into the canvas, positioned by
pointer or keyboard, connected through accessible handles, selected, and
removed. Input and Output remain unique protected boundaries. Structural
validation stays visible without pretending that workspace persistence or
runtime execution already exists.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It consumes the framework-independent definition in
`app-core/agent-graph`; future persistence and execution should arrive through
dedicated Graph interfaces.
