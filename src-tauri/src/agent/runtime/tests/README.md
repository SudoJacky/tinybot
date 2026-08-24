# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:94aa23f98dff9eae44f38bb8dbc0e818a3ea96a720eca0e6cfa063974cdac7d0 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Context coverage includes compaction and trimming budgets, provider-visible
tool-definition estimates, and normalization of nested cache and reasoning
usage details. It also verifies known-model context defaults, the legacy
unknown-model fallback, and Provider Profile per-model overrides.

Shared fixtures and helpers live in `mod.rs`.

Lifecycle coverage verifies prompt, before-tool, and after-tool hook stages and
confirms that normalized before-tool replacements reach dispatch. Interaction
coverage keeps resumable user-input checkpoints and their deferred tool-hook
context on the same Turn.
