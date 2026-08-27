# Agent Providers
<!-- tinybot-module-fingerprint: sha256:cb7b3d424410b438efd60ea80e5962ab0a6249e8e618145c320dcd4cd9406740 -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

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
