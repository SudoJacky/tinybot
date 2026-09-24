# RPC Tests
<!-- tinybot-module-fingerprint: sha256:00b887a577dc453a79d2dfd0916c87d125fa07c9d692d7760a6475261dabe98a -->

This directory groups end-to-end router tests by service family. The suites
cover request validation and dispatch for automation, collaboration, threads,
tools, workspaces, shell operations, retained-process continuation through the
generic tool executor, and schema v2 Config-store writes.

File-search cases use the bundled executable through the real tool executor,
verify default catalog selection with only read permission, reject invalid or
denied requests, and confirm cancellation reaches the workspace search service.

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

Registry search coverage verifies that subagent lifecycle controls are absent
from model exposure and remain available when explicitly filtered as direct.
