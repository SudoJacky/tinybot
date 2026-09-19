# RPC Tests
<!-- tinybot-module-fingerprint: sha256:4dc83324cecfbea93c87ea70d56e5d2f3900e0da66b309d05f41b395d61ab735 -->

This directory groups end-to-end router tests by service family. The suites
cover request validation and dispatch for automation, collaboration, threads,
tools, workspaces, shell operations, retained-process continuation through the
generic tool executor, and schema v2 Config-store writes.

`action_fusion.rs` exercises actual patch-before-command execution, preflight
rejection without edits, patch failure without a command, nonzero command exit
with edits retained, cancellation, and owned-process continuation.
Directory-dependency cases run commands in directories created by the same patch
through absolute and relative paths; invalid post-patch directories retain edit
evidence and explicit startup failures without creating directories implicitly.
Long Unicode report cases verify bounded parse diagnostics through ordinary and
fused tool dispatch, no changes or commands on parse failure, and successful
resubmission after correcting the missing content prefix.

Shared router fixtures live in `mod.rs`.

Router fixtures use the same persistent Thread store as production. Reopening
a router reloads canonical Rollouts on the first Thread operation; there is no
separate persistent-session constructor or injected in-memory session list.
