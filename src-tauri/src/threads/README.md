# Threads
<!-- tinybot-module-fingerprint: sha256:51960cb53827128fdeff064d14deec447c1ac7a64d09dcf6922820073b1f2397 -->

`threads` owns conversation state and its durable rollout representation.

`turn_service.rs` provides typed operations on `WorkspaceThreadStore` for turn
records, history, runtime events, and checkpoints. Internal callers and the RPC
adapter share lifecycle locking, canonical writes, projection synchronization,
and failure recovery. RPC envelopes are only needed at transport boundaries.

The domain layer exposes thread operations, while `rollout/` handles persisted
event lines and reconstruction. This module also contains time helpers, turn
records, workspace stores, project-group membership access, and named storage
migrations. `WorkspaceThreadStore` also carries the shared workspace-registry
and project-group handles used by desktop commands. Project groups authorize
coordinator Turns to create persistent Threads in registered member workspaces;
those Threads still use the normal rollout and domain paths.

Generated conversation titles use a narrow `WorkspaceThreadStore` operation so
the guarded domain update and canonical Rollout persistence share the same
lifecycle lock as manual metadata changes.

Production stores require an explicit application data root. The constructor
that derives `<workspace>/.tinybot` is available only to tests, including legacy
storage migration fixtures.

Storage metrics separate lifecycle-lock wait, canonical path discovery, index
rebuild/population, Rollout head hashing, file read/decompression, JSON parsing,
ordinal validation, reconstruction and projection build/install. Cache hit,
miss and eviction counts plus decoded line bytes and line counts explain work
volume. Timings can be nested; per-file I/O/parse sums are not wall-clock spans.
The read/parse total retains failure outcomes without changing storage results.

Team conversation stores keep the application data root distinct from their
rollout root. `for_team` caches one isolated store per run without hydrating it;
normal Thread initialization never walks `team-runs`. Shared shutdown/flush
drains opened scopes. A one-time startup migration moves old Team and descendant
logs before any recorder is created, retaining their canonical relative paths.
