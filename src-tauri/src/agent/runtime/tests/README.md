# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:1c5dcbdebdf2c21a166d58b1c9d7b07d3d0e34de2c66872506a7aec40a2be01a -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Shared fixtures and helpers live in `mod.rs`.

Lifecycle coverage verifies prompt, before-tool, and after-tool hook stages and
confirms that normalized before-tool replacements reach dispatch. Interaction
coverage keeps resumable user-input checkpoints and their deferred tool-hook
context on the same Turn.
