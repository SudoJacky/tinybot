# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:851e3ccc3dba27679bf647f794850b9e9f4ad5c50dce7768f0e638fec1a2f44b -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Context coverage includes compaction and trimming budgets, estimates of the
fully assembled provider request (including Responses-native replay), and
normalization of nested cache and reasoning usage details. It also verifies
known-model context defaults, the legacy unknown-model fallback, and Provider
Profile per-model overrides.

Shared fixtures and helpers live in `mod.rs`.

Lifecycle coverage verifies prompt, before-tool, and after-tool hook stages and
confirms that normalized before-tool replacements reach dispatch. Interaction
coverage keeps resumable user-input checkpoints and their deferred tool-hook
context on the same Turn.

Tool coverage verifies provider call/result pairing, multi-call batches, and
native tool errors that remain model-visible so the next provider iteration can
respond. Data-view cases cover successful artifact publication and parseable
arguments rejected by the native schema. Malformed argument JSON covers both a
single call and a partially invalid batch, asserting that dispatch is blocked,
every call ID receives a non-empty error result, and the provider loop
continues.
