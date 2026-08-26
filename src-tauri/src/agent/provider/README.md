# Agent Providers
<!-- tinybot-module-fingerprint: sha256:72debde400ecf2083f327787a4d790df4f173eb4c701821225c54c9ff82daa59 -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models. Live discovery stays
  async end to end, calls the authenticated OpenAI-compatible `GET /models`
  endpoint, and requires only `data[].id` from each provider response. Custom
  providers default `supportsReasoningEffort` to `true`; an explicit `false`
  keeps effort out of provider requests. Profile `modelContextWindows` entries
  are normalized into positive per-model context-window overrides.
- `completion.rs` performs provider requests. Provider selection preserves an
  explicit request override, then uses the active profile, and only infers from
  the model when neither is configured.
- `streaming.rs` normalizes streamed provider events.
