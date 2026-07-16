# Local Thread Store

`worker_thread::local_store` is the durable local implementation of
`ThreadStore`. It keeps an append-only JSONL journal as the canonical source of
Thread records and items, with SQLite as a rebuildable query projection.

## Storage model

For a workspace root, the store uses:

| Path | Role |
| --- | --- |
| `.tinybot/state/thread-store.jsonl` | Canonical operation journal |
| `.tinybot/threads/threads.sqlite` | Query projection for records and items |

Each journal line is a versioned operation containing one or more mutations:

- upsert a Thread record;
- replace/upsert the stored items for a Thread;
- delete a Thread.

The SQLite metadata stores the journal head it represents. A write is accepted
only when the canonical head and projection head agree.

## Write protocol

Mutations are serialized by the store's shared mutation lock:

1. Read the canonical and projection heads.
2. Reject the write if the store is a legacy projection or the heads diverge.
3. Append a complete operation to the canonical journal.
4. Apply the same logical state to the SQLite projection.
5. Advance the projection head to the appended journal operation.

This order makes an interrupted projection update detectable. Do not bypass it
with direct writes to `threads.sqlite`.

## Consistency and repair

`check_persistence_consistency` reports one of:

- `clean`: canonical state, projection state, and heads agree;
- `legacy_projection`: SQLite contains pre-journal state;
- `diverged`: the journal and projection differ.

Repair is explicit:

- `migrate_legacy_projection` creates the initial canonical journal operation
  from a pre-journal SQLite store.
- `rebuild_projection` recreates SQLite state from an existing canonical
  journal.

Startup lifecycle code may run the named legacy migration. Unexpected
divergence remains a visible failure and must not be silently overwritten.

## Internal layout

- `journal.rs`: canonical operations, replay, consistency checks, migrations,
  and projection repair.
- `index.rs`: SQLite schema and record/item projection IO.
- `mod.rs`: `ThreadStore`, `LocalThreadStore`, mutation orchestration, and the
  public store behavior.
- `memory.rs`: in-memory `ThreadStore` implementation.
- `metadata.rs`, `query.rs`, `fork.rs`: metadata rules, bounded queries, and
  fork/archive behavior.
- `checkpoint.rs`, `activity.rs`: checkpoint and activity projections.
- `agent_run_projection.rs`, `runtime_projection.rs`,
  `subagent_projection.rs`: derived views over canonical items.

## Invariants

- The JSONL journal is canonical; SQLite is a projection.
- Journal operations are schema-versioned and contain at least one mutation.
- Mutations are serialized within one process by the shared lock.
- Projection head advancement happens only after the projection update.
- Reads are bounded by module limits; callers cannot request unbounded lists or
  item history.
- Record and item IDs must be path-safe and internally consistent.
- Repair never invents state: migration reads the legacy projection, while
  rebuild reads the canonical journal.

Changes to journal schema, mutation ordering, or repair semantics require
targeted persistence tests and an update to this README.
