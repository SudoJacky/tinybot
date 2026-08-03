# Threads

`threads` owns conversation state and its durable rollout representation.

The domain layer exposes thread operations, while `rollout/` handles persisted
event lines and reconstruction. This module also contains time helpers, turn
records, workspace stores, and named storage migrations.
