# Agent Providers
<!-- tinybot-module-fingerprint: sha256:8aff12bd90b2dcc07e1188699307cde57e816e9a5e953ffdabd25998d39997a7 -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models. Live discovery stays
  async end to end, calls the authenticated OpenAI-compatible `GET /models`
  endpoint, and requires only `data[].id` from each provider response. Custom
  providers default `supportsReasoningEffort` to `true`; an explicit `false`
  keeps effort out of provider requests. Profile `modelContextWindows` entries
  are normalized into positive per-model context-window overrides.
- `completion.rs` performs provider requests.
- `streaming.rs` normalizes streamed provider events.
