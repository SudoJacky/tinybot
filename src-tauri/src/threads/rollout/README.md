# Thread Rollout
<!-- tinybot-module-fingerprint: sha256:4fde31f636835d68e1bf620a1ab8b419e5867adaec5ded4fbd51d5c5e697c872 -->

`rollout` defines Tinybot's durable, append-oriented thread history.

- `format/` owns serialized item types and reconstruction rules.
- `store/` reads, writes, indexes, and projects rollout data.
- `checkpoint_lineage.rs` tracks checkpoint ancestry.

Model replay preserves structured content and the origin of native tool items.
Transcript reconstruction separately derives display text. `get_agent_context`
loads the complete effective history after rollback/checkpoint rules, leaving
window selection to the runtime; count-limited reads remain presentation APIs.
Response items retain their original Thread and Rollout ordinal when inherited
by a fork. Input admission is idempotent by identity and rejects identity reuse
with different content or origin before appending the batch.
