# Agent
<!-- tinybot-module-fingerprint: sha256:91cafba2811b5e2e937346bb9367c02613aa348320288e2ad6513da838d5b7d9 -->

`agent` contains the native agent stack. It connects provider configuration,
the turn runtime, durable runtime events, and the desktop integration bridge.

Provider-specific transport details stay in `provider/`, while turn execution
and event projection live in `runtime/` and `runtime_protocol/`.
The built-in Ollama Provider uses the local OpenAI-compatible endpoint without
requiring an API key; its plugin owns the small Chat Completions field mapping
while shared model discovery, streaming, and response decoding remain in the
common Provider runtime.
Provider selection requires an explicit Provider or active Profile; model names
never select a Provider implicitly.
`router.rs` is the deliberately smaller Agent Graph routing seam: it builds one
dedicated, non-streaming, tool-free provider request, strictly maps the complete
`ROUTE_*` response to a stable definition route ID, and does not enter the
Agent Loop or create a Thread. Router requests preserve explicit node provider
overrides and otherwise use the active application provider profile.
