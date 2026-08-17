# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:fa2de1a3c491cb8aa8b5521340934ecab394acd5f91dfde696e284ea298bdd65 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Shared fixtures and helpers live in `mod.rs`.
