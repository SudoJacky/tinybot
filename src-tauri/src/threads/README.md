# Threads
<!-- tinybot-module-fingerprint: sha256:70e4724e128341604e5f5aa90709b0a12de99b7dc50827b58b51bbe1c0998c01 -->

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
