# Agent Runtime Protocol
<!-- tinybot-module-fingerprint: sha256:1ded71978f34bf8dce54b7d473321600ff443a0ecd3caf8681d950c1de14cad3 -->

`runtime_protocol` defines the durable events exchanged by the agent runtime
and the projections built from them.

It owns wire types, event-name validation, event appending, and timeline
projection. Provider-specific payloads should be normalized before reaching
this boundary.

Replay retains persisted event IDs, sequence numbers, and timestamps. Timeline
projection validates assistant message phase transitions per item so malformed
causality fails instead of being silently reordered or duplicated.

Usage timeline items treat the typed `agentItem` as canonical. Their projected
payload omits the redundant enriched `usage` and raw `providerUsage` event
fields once the typed item contains explicit normalized context metrics and the
original provider usage payload.
