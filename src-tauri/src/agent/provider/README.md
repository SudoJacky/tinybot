# Agent Providers
<!-- tinybot-module-fingerprint: sha256:1a61ca5b3c0e34bb4fe3368457a842d8f134951b1b5875c061b515f0a868ec6a -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

- `plugins/` contains the statically registered Provider adapters. Every
  built-in Provider implements the shared `ProviderPlugin` interface and owns
  its catalog manifest, reasoning-effort policy, and wire-request adaptations.
  The shared protocol and transport flow remains outside individual adapters;
  custom OpenAI-compatible Providers use the default pass-through policy.
  The built-in Ollama adapter uses `http://127.0.0.1:11434/v1` without requiring
  an API key, discovers locally installed models, and maps Chat Completions
  `max_completion_tokens` to Ollama's `max_tokens` field.
- `catalog.rs` resolves configured providers and models. Live discovery stays
  async end to end, calls the authenticated OpenAI-compatible `GET /models`
  endpoint, and requires only `data[].id` from each provider response. Custom
  providers default `supportsReasoningEffort` to `true`; an explicit `false`
  keeps effort out of provider requests. Profile `modelContextWindows` entries
  are normalized into positive per-model context-window overrides. Profile
  `modelCapabilities` entries override built-in input modalities per model;
  `glm-5.3-flash` and `deepseek-v4-flash-vision-exp` accept images by default.
  Built-in providers declare their supported protocol modes; Z.ai is Chat
  Completions only and uses a static GLM model list.
- `completion.rs` performs provider requests. Provider selection preserves an
  explicit request override, then uses the active profile, and only infers from
  the model when neither is configured. API base URLs are normalized before
  the OpenAI-compatible request path is appended.
- `streaming.rs` normalizes streamed provider events.
