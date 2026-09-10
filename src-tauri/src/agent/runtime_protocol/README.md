# Agent Runtime Protocol
<!-- tinybot-module-fingerprint: sha256:bff1fdaee4c3e6fd14a249664a396ddadc3098a269a4bd9225a4509eb4eb1a53 -->

`runtime_protocol` defines the durable events exchanged by the agent runtime
and the projections built from them.

It owns wire types, event-name validation, event appending, and timeline
projection. Provider-specific payloads should be normalized before reaching
this boundary.

Replay retains persisted event IDs, sequence numbers, and timestamps. Timeline
projection validates assistant message phase transitions per item so malformed
causality fails instead of being silently reordered or duplicated.

Textual reasoning deltas project as one user-visible running item without
advancing the durable timeline revision. Reasoning completion advances the
revision and completes that item. A provider may complete an existing reasoning
item after final-answer streaming starts, but it may not create new post-final
work; debug-only reasoning events remain excluded.

Usage timeline items treat the typed `agentItem` as canonical. Their projected
payload omits the redundant enriched `usage` and raw `providerUsage` event
fields once the typed item contains explicit normalized context metrics and the
original provider usage payload.

Usage Items optionally carry `modelTiming` with a model-call identity, TTFT,
and decode duration in milliseconds. Typed live projection and durable replay
retain the same values. Older v2 Items omit the field; no schema migration is
needed and absent timing remains unavailable.

Form resolution is a durable event. Its values and command correlation are
persisted before the completed form timeline patch reaches the renderer.
The initial form request remains represented durably by its awaiting-form checkpoint.
