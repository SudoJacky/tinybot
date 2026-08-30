# Agent
<!-- tinybot-module-fingerprint: sha256:99cd2117431fcd734b61af9b3ca9c17361e6d422205f3fada3bfd442bace294c -->

`agent` contains the native agent stack. It connects provider configuration,
the turn runtime, durable runtime events, and the desktop integration bridge.

Provider-specific transport details stay in `provider/`, while turn execution
and event projection live in `runtime/` and `runtime_protocol/`.
The built-in Ollama Provider uses the local OpenAI-compatible endpoint without
requiring an API key; its plugin owns the small Chat Completions field mapping
while shared model discovery, streaming, and response decoding remain in the
common Provider runtime.
`router.rs` is the deliberately smaller Agent Graph routing seam: it builds one
dedicated, non-streaming, tool-free provider request, strictly maps the complete
`ROUTE_*` response to a stable definition route ID, and does not enter the
Agent Loop or create a Thread. Router requests preserve explicit node provider
overrides and otherwise use the active application provider profile.
