# Threads
<!-- tinybot-module-fingerprint: sha256:abc370695080faf52c310ff351c51681d4b9ce97fad4bde41895c50024817cef -->

`threads` owns conversation state and its durable rollout representation.

The domain layer exposes thread operations, while `rollout/` handles persisted
event lines and reconstruction. This module also contains time helpers, turn
records, workspace stores, project-group membership access, and named storage
migrations. Project groups authorize coordinator Turns to create persistent
Threads in member workspaces; those Threads still use the normal rollout and
domain paths.
