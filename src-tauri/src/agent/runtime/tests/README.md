# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:80210eb57e9a6a5479185e7573f987f6ab68107d461f004045dc5e58b03683a0 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults. It also covers the Z.ai Chat
Completions-only contract, its provider-specific request fields, and default
OpenAI-compatible reasoning-effort passthrough. Provider fixtures use explicit
Provider IDs or active Profiles; the retired Auto routing value is covered only
by migration and rejection tests at the owning boundaries.

Context coverage includes compaction and trimming budgets, estimates of the
fully assembled provider request (including Responses-native replay), and
normalization of nested cache and reasoning usage details. It also verifies
known-model context defaults, the legacy unknown-model fallback, and Provider
Profile per-model overrides.

Shared fixtures and helpers live in `mod.rs`.

Lifecycle coverage verifies prompt, before-tool, and after-tool hook stages and
confirms that normalized before-tool replacements reach dispatch. It also
checks that provider reasoning has matching live and reloaded canonical items.
Interaction coverage keeps resumable user-input checkpoints and their deferred tool-hook
context on the same Turn.

Tool coverage verifies provider call/result pairing, multi-call batches, and
native tool errors that remain model-visible so the next provider iteration can
respond. Data-view cases cover successful artifact publication and parseable
arguments rejected by the native schema. Malformed argument JSON covers both a
single call and a partially invalid batch, asserting that dispatch is blocked,
every call ID receives a non-empty error result, and the provider loop
continues. Dispatcher coverage also verifies that retired alternative
subagent tool names are rejected as unknown instead of reaching execution.
