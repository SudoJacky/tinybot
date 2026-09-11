# RPC Tests
<!-- tinybot-module-fingerprint: sha256:1bc04a825969c8103014474a5ddf6b5b3197ea10f6ae340a6b43decfda069922 -->

This directory groups end-to-end router tests by service family. The suites
cover request validation and dispatch for automation, collaboration, threads,
tools, workspaces, shell operations, retained-process continuation through the
generic tool executor, and schema v2 Config-store writes.

`action_fusion.rs` exercises actual patch-before-command execution, preflight
rejection without edits, patch failure without a command, nonzero command exit
with edits retained, cancellation, and owned-process continuation.

Shared router fixtures live in `mod.rs`.

Router fixtures use the same persistent Thread store as production. Reopening
a router reloads canonical Rollouts on the first Thread operation; there is no
separate persistent-session constructor or injected in-memory session list.
