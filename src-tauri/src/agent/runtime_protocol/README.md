# Agent Runtime Protocol
<!-- tinybot-module-fingerprint: sha256:7bc45e5028259de6d5db04a19a8be61b4983e272ae135cd64c9f629b03c663f3 -->

`runtime_protocol` defines the durable events exchanged by the agent runtime
and the projections built from them.

It owns wire types, event-name validation, event appending, and timeline
projection. Provider-specific payloads should be normalized before reaching
this boundary.

Replay retains persisted event IDs, sequence numbers, and timestamps. Timeline
projection validates assistant message phase transitions per item so malformed
causality fails instead of being silently reordered or duplicated.
