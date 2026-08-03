# Agent Providers

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `catalog.rs` resolves configured providers and models.
- `completion.rs` performs provider requests.
- `streaming.rs` normalizes streamed provider events.
