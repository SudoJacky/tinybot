# Agent Providers
<!-- tinybot-module-fingerprint: sha256:c5d11da667de0eab9d5237655aa1b3a5798d8d0d44a26daf08c0ee3cc3f5ec05 -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models.
- `completion.rs` performs provider requests.
- `streaming.rs` normalizes streamed provider events.
