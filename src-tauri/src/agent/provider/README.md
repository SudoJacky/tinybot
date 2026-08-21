# Agent Providers
<!-- tinybot-module-fingerprint: sha256:8279be1190e5d0c33a364c5a1e27c4b1440eb509956761b4c465d246fe405d0f -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models. Live discovery stays
  async end to end, calls the authenticated OpenAI-compatible `GET /models`
  endpoint, and requires only `data[].id` from each provider response.
- `completion.rs` performs provider requests.
- `streaming.rs` normalizes streamed provider events.
