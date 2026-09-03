# Agent
<!-- tinybot-module-fingerprint: sha256:25cf7836ef07b187290ab3138b7d5d1cc4f43f3567d8cc9acabe017c2aeaf2b9 -->

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
Chat Completions and Responses keep their wire usage payloads intact while the
crate-level token-usage mapper provides one canonical representation for
runtime accounting, Rollout token counts, and daily totals.
`router.rs` is the deliberately smaller Agent Graph routing seam: it builds one
dedicated, non-streaming, tool-free provider request, strictly maps the complete
`ROUTE_*` response to a stable definition route ID, and does not enter the
Agent Loop or create a Thread. Router requests preserve explicit node provider
overrides and otherwise use the active application provider profile.
