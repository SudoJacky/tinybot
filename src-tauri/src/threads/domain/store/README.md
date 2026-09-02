# Thread Stores
<!-- tinybot-module-fingerprint: sha256:13d3ebe4dfdb7d86edac703f583a4a3c87de9e4c11dc42815587656d87c1e002 -->

This module implements thread storage operations and projections used by the
thread domain.

It covers metadata, indexes, turns, checkpoints, forks, activity, memory,
subagents, queries, and conversion from stored items into runtime views.
Runtime projection preserves canonical event identity and ordering and avoids
emitting duplicate lifecycle fallbacks when a semantic event already exists.
Persisted provider reasoning prefers summary text and falls back to textual
reasoning content when reconstructing the user-visible timeline.
When persisted Thread-item sequences are sparse, projection restores Rollout
append order from canonical creation timestamps while retaining each runtime
event's source sequence as identity metadata.
