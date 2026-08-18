# Agent Runtime Tests
<!-- tinybot-module-fingerprint: sha256:036630bf73b6753ced70b85af5ac191901fe54af1117304c0d46a1d76aee88d7 -->

This directory groups the larger agent runtime test suites by concern:
configuration, context, interactions, lifecycle, and tools.

Configuration coverage includes runtime fallbacks and precedence between Turn
settings and configured Agent defaults.

Shared fixtures and helpers live in `mod.rs`.
