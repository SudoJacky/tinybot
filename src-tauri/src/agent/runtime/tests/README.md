# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:48ce75b39491a9d225c847cfc16210b4bba0e44a0baea735ea5f3057d14046e7 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Context coverage includes compaction and trimming budgets, provider-visible
tool-definition estimates, and normalization of nested cache and reasoning
usage details.

Shared fixtures and helpers live in `mod.rs`.

Lifecycle coverage verifies prompt, before-tool, and after-tool hook stages and
confirms that normalized before-tool replacements reach dispatch. Interaction
coverage keeps resumable user-input checkpoints and their deferred tool-hook
context on the same Turn.
