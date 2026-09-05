# Thread Stores
<!-- tinybot-module-fingerprint: sha256:69fc0f62ef53d1a1ea7f558a7b4b3a5789645238bcee7403dff4c7b4bd446cb1 -->

This module implements thread storage operations and projections used by the
thread domain.

It covers metadata, indexes, turns, checkpoints, forks, activity, memory,
subagents, queries, and conversion from stored items into runtime views.
Runtime projection preserves canonical event identity and ordering and avoids
emitting duplicate lifecycle fallbacks when a semantic event already exists.
Typed usage replay preserves optional per-model timings with their output counts;
tests cover reloading those fields without changing the stored Item format.
Persisted provider reasoning prefers summary text and falls back to textual
reasoning content when reconstructing the user-visible timeline.
When a completed semantic reasoning event and its provider-native reasoning
record both exist, the semantic event owns the timeline item while the native
record remains available for exact provider replay.
When persisted Thread-item sequences are sparse, projection restores Rollout
append order from canonical creation timestamps while retaining each runtime
event's source sequence as identity metadata.
Generated-title mutation validates the first user Turn while holding the store
lock, rejects archived or manually titled Threads, and records `titleSource` as
`model` only when the compare-and-set succeeds.
