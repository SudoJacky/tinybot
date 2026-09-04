# Agent
<!-- tinybot-module-fingerprint: sha256:f770571dde5dac3d3edc57fd65e4e4bd0aff915081b568891d3798b7a56cbc93 -->

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
`conversation_title.rs` owns the smaller first-Turn title path. It issues one
bounded, non-streaming, tool-free request with the Turn's resolved Provider and
model, normalizes the result, and commits it asynchronously without entering the
Agent Loop or delaying that Turn. Responses-mode title parsing accepts only
assistant `message` / `output_text` content and ignores Provider reasoning items.
