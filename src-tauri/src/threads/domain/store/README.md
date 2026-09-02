# Thread Stores
<!-- tinybot-module-fingerprint: sha256:6e3f4685904c24ca901e218b37cbd0b9fbf0431a5a1f4dc841a4cbcb28e6fe95 -->

This module implements thread storage operations and projections used by the
thread domain.

It covers metadata, indexes, turns, checkpoints, forks, activity, memory,
subagents, queries, and conversion from stored items into runtime views.
Runtime projection preserves canonical event identity and ordering and avoids
emitting duplicate lifecycle fallbacks when a semantic event already exists.
Persisted provider reasoning prefers summary text and falls back to textual
reasoning content when reconstructing the user-visible timeline.
When a completed semantic reasoning event and its provider-native reasoning
record both exist, the semantic event owns the timeline item while the native
record remains available for exact provider replay.
When persisted Thread-item sequences are sparse, projection restores Rollout
append order from canonical creation timestamps while retaining each runtime
event's source sequence as identity metadata.
