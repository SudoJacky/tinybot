# Threads
<!-- tinybot-module-fingerprint: sha256:16ecdd28c44b1c0599c25f0d876452ee284a9c3ee11ebe5888c768020290a04e -->

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
