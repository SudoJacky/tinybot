# Thread Rollout

`rollout` defines Tinybot's durable, append-oriented thread history.

- `format/` owns serialized item types and reconstruction rules.
- `store/` reads, writes, indexes, and projects rollout data.
- `checkpoint_lineage.rs` tracks checkpoint ancestry.
