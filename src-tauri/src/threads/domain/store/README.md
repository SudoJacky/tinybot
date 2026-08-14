# Thread Stores
<!-- tinybot-module-fingerprint: sha256:a41130f6b713eb02ed62bff93750770b7986c2d3cc9bd339ffa871b41cc8b289 -->

This module implements thread storage operations and projections used by the
thread domain.

It covers metadata, indexes, turns, checkpoints, forks, activity, memory,
subagents, queries, and conversion from stored items into runtime views.
Runtime projection preserves canonical event identity and ordering and avoids
emitting duplicate lifecycle fallbacks when a semantic event already exists.
