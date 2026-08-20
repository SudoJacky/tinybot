# Agent Graph Workbench
<!-- tinybot-module-fingerprint: sha256:db10ec9b16e155d7517a16c1be8cf7efaeed6ae045c9b142a6c6b9615effe6fd -->

`agent-graph` owns the standalone Agent Graph route and its React presentation.
The initial page creates one honest in-memory starter draft, exposes structural
validation, and describes the supported node kinds without pretending that
workspace persistence or runtime execution already exists.

This module does not import `ChatPage`, consume Chat route state, or treat a
Graph as a Chat mode. It consumes the framework-independent definition in
`app-core/agent-graph`; future persistence and execution should arrive through
dedicated Graph interfaces.
