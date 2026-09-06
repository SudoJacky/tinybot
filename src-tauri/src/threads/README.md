# Threads
<!-- tinybot-module-fingerprint: sha256:0a12b7a1e73e011a33c6e52d31b0b3c224647a0575e7d476c8fc38c82b0c2322 -->

`threads` owns conversation state and its durable rollout representation.

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
