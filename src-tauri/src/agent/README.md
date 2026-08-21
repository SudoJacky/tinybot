# Agent
<!-- tinybot-module-fingerprint: sha256:a53a8a42c9c87806dbc7a33b4eea6454a9e2d84f65e08cfafee3192e783f285c -->

`agent` contains the native agent stack. It connects provider configuration,
the turn runtime, durable runtime events, and the desktop integration bridge.

Provider-specific transport details stay in `provider/`, while turn execution
and event projection live in `runtime/` and `runtime_protocol/`.
`router.rs` is the deliberately smaller Agent Graph routing seam: it builds one
dedicated, non-streaming, tool-free provider request, strictly maps the complete
`ROUTE_*` response to a stable definition route ID, and does not enter the
Agent Loop or create a Thread.
