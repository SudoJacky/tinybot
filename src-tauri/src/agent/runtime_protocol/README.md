# Agent Runtime Protocol
<!-- tinybot-module-fingerprint: sha256:ee543fb89a7ba55d3fad1ad2e0cd57c56b75f07d6197ec2dfcaec0e79f7a2f71 -->

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
revision and completes that item; debug-only reasoning events remain excluded.

Usage timeline items treat the typed `agentItem` as canonical. Their projected
payload omits the redundant enriched `usage` and raw `providerUsage` event
fields once the typed item contains explicit normalized context metrics and the
original provider usage payload.
