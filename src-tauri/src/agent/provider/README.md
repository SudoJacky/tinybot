# Agent Providers
<!-- tinybot-module-fingerprint: sha256:9d09486427d6989f83354120f92589b3853e19cf77fbeda7e844ae4ebc916bf4 -->

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
- `completion.rs` performs provider requests. Provider selection requires an
  explicit request override or an active profile; it never infers a Provider
  from the model, and the retired `auto` Provider ID is rejected. API base URLs
  are normalized before the OpenAI-compatible request path is appended. Every
  successful Chat Completions or Responses call that reports usage passes through
  the same token-field mapper and records the canonical result at this shared
  boundary, so Agent turns, context compaction, memory maintenance, and Agent
  Graph routing all feed the same daily SQLite totals. A response without usage
  is not recorded as a zero-token call. The recorded dimensions use the resolved
  Provider profile and the response model ID, with the requested model as a
  fallback. Usage persistence is best effort: failures increment
  `provider.tokenUsage.persistence.failed` and emit a diagnostic with the
  protocol, model ID, and storage error without replacing a successful provider
  response.
- `streaming.rs` normalizes streamed provider events. Responses reasoning
  accepts both summary deltas and provider-compatible textual reasoning deltas.
  Non-empty tool names and argument deltas also notify the runtime's timing
  observer in both protocols; empty chunks and metadata do not mark first output.
