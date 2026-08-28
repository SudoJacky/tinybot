# Threads
<!-- tinybot-module-fingerprint: sha256:ecd97886eeacfe6b413838f7699dce1920260bb7400c781894dad98a96899bca -->

`threads` owns conversation state and its durable rollout representation.

The domain layer exposes thread operations, while `rollout/` handles persisted
event lines and reconstruction. This module also contains time helpers, turn
records, workspace stores, project-group membership access, and named storage
migrations. Project groups authorize coordinator Turns to create persistent
Threads in member workspaces; those Threads still use the normal rollout and
domain paths.
