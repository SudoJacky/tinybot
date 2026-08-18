# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:3938f10e8e908527629459242700621362484af74d518fe0a3b1c0e7714ec163 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Shared fixtures and helpers live in `mod.rs`.
