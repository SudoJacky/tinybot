# RPC Tests
<!-- tinybot-module-fingerprint: sha256:63ba60962105b9a23d79ae16adc632840d7eada716f2a00878c2c298960538a8 -->

This directory groups end-to-end router tests by service family. The suites
cover request validation and dispatch for automation, collaboration, threads,
tools, workspaces, shell operations, retained-process continuation through the
generic tool executor, and schema v2 Config-store writes.

Shared router fixtures live in `mod.rs`.

Router fixtures use the same persistent Thread store as production. Reopening
a router reloads canonical Rollouts on the first Thread operation; there is no
separate persistent-session constructor or injected in-memory session list.
