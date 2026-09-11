# RPC Tests
<!-- tinybot-module-fingerprint: sha256:d8dbf77361a87fef334e9bdca49777c66ce124b1fa4f1e34b514df915feb8aa7 -->

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

Shared router fixtures live in `mod.rs`.

Router fixtures use the same persistent Thread store as production. Reopening
a router reloads canonical Rollouts on the first Thread operation; there is no
separate persistent-session constructor or injected in-memory session list.
