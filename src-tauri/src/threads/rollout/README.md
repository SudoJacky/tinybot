# Thread Rollout
<!-- tinybot-module-fingerprint: sha256:8afa40d4497bd5ffdcf386ac5fd7d58d560fd29712e0b14ae471c5a13cf6f6bf -->

`rollout` defines Tinybot's durable, append-oriented thread history.

- `format/` owns serialized item types and reconstruction rules.
- `store/` reads, writes, indexes, and projects rollout data.
- `checkpoint_lineage.rs` tracks checkpoint ancestry.
