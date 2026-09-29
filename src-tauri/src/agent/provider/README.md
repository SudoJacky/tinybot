# Agent Providers
<!-- tinybot-module-fingerprint: sha256:0e81198ad84b6555735a85d6d5bb97142498862c6ed91b94ca15448cc2b4b565 -->

This module resolves provider and model configuration and performs streaming
Chat Completions or Responses API requests.

The built-in default model is `deepseek-flash`; explicit configured models retain
their existing selection.

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
  `glm-5.3-flash` on Z.ai, and `deepseek-flash` and the legacy Flash aliases on
  DeepSeek accept images by default. Matching model names on other providers
  need explicit Profile capabilities.
  Built-in providers declare their supported protocol modes; Z.ai is Chat
  Completions only and uses a static GLM model list.
- `model.rs` resolves one credential-free `ResolvedModel` from a selected Profile
  and its provider's model defaults. Context budgeting, input validation,
  optional capabilities, reasoning policy, and Chat compatibility consume this
  description. Context priority is Turn override, Profile model override,
  provider/model default, legacy Agent default, then 128,000 tokens. Endpoints
  and credentials remain Profile-scoped. Compatibility declares the maximum
  token field, streaming usage support, and parallel-tool support; genuinely
  vendor-specific validation stays in the plugin hook.
  `model-defaults.json` is the single built-in window/modality table, embedded
  into Rust and imported by the frontend settings model. Adding a definition
  updates runtime validation, model selectors, and settings defaults together.
- `completion.rs` performs provider requests. Provider selection requires an
  explicit request override or an active profile; it never infers a Provider
  from the model, and the retired `auto` Provider ID is rejected. API base URLs
  are normalized before the OpenAI-compatible request path is appended. Every
  Chat Completions or Responses invocation records a pending entry in the shared
  token-usage ledger before execution. Completion atomically records normalized
  usage and updates existing daily totals. Missing usage remains null. Trusted
  purpose and Team/Thread/Turn identities come from the application usage scope,
  never model arguments. Records use the resolved Provider and response model
  (or requested model when absent). Storage failures increment
  `provider.tokenUsage.persistence.failed`, emit diagnostics, and fail the call
  explicitly; a completed provider request is never silently left unaccounted.
- `outcome.rs` owns terminal-response validation for streaming and non-streaming
  calls in both protocols. Chat `finish_reason` and Responses `status` /
  `incomplete_details.reason` must explicitly confirm success or tool use.
  Truncation, content filtering, unknown/missing termination, and inconsistent
  tool termination fail before decoding or dispatch. Raw reasons remain in
  errors; normalized finish metrics and provider/model/protocol diagnostics
  expose failures. A failed terminal response retains any reported token usage.
- `retry.rs` owns the observable HTTP retry budget, replacing the SDK's hidden
  default executor. It permits three additional attempts on connection errors,
  HTTP 5xx, and parseable HTTP 429 rate-limit errors; insufficient quota is
  permanent. Backoff is 100/200/400 ms unless an integer-seconds Retry-After
  header is supplied. Requests emit waiting/requesting/cleared observer updates.
  Overall request timeout and cancellation include the retry wait; an opened
  response stream is never restarted. Successful assistant content, including
  error-looking text, is not classified as a transport failure.
  Each retry records a distinct invocation under the same logical request ID;
  duplicate completion delivery cannot add tokens again.
- `streaming.rs` normalizes streamed provider events. Responses reasoning
  accepts both summary deltas and provider-compatible textual reasoning deltas.
  Non-empty tool names and argument deltas also notify the runtime's timing
  observer in both protocols; empty chunks and metadata do not mark first output.
  Chat aggregation retains the actual finish reason across trailing usage
  chunks; it never derives success from the presence or absence of tools.
  Responses retains completed, incomplete, and failed terminal response bodies
  for the shared outcome validator and usage recorder.

`validate_provider_configuration` reuses client construction to validate API
mode, endpoint presence, and required credentials without issuing a request.
Saved automation preflight uses it before claiming a run.
