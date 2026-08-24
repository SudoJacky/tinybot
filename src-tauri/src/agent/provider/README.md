# Agent Providers
<!-- tinybot-module-fingerprint: sha256:6df8e37632e36e63d8997dad55da82d9c861e19d6f72473edfec4e8d16f4635b -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models. Live discovery stays
  async end to end, calls the authenticated OpenAI-compatible `GET /models`
  endpoint, and requires only `data[].id` from each provider response. Custom
  providers default `supportsReasoningEffort` to `true`; an explicit `false`
  keeps effort out of provider requests.
- `completion.rs` performs provider requests.
- `streaming.rs` normalizes streamed provider events.
