# Thread Rollout
<!-- tinybot-module-fingerprint: sha256:4fde31f636835d68e1bf620a1ab8b419e5867adaec5ded4fbd51d5c5e697c872 -->

`rollout` defines Tinybot's durable, append-oriented thread history.

- `format/` owns serialized item types and reconstruction rules.
- `store/` reads, writes, indexes, and projects rollout data.
- `checkpoint_lineage.rs` tracks checkpoint ancestry.
