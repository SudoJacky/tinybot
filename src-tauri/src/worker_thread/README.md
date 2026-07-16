# Worker Thread

`worker_thread` is Tinybot's typed conversation domain. It defines Thread
records, items, lifecycle operations, active-run projections, and the storage
boundary used by new Thread-owned flows.

The module deliberately separates canonical Thread semantics from
session-shaped compatibility APIs. See [`worker_session`](../worker_session/README.md)
and [`worker_thread_log`](../worker_thread_log/README.md) for those surfaces.

## Responsibilities

- Define typed Thread records, metadata, items, events, requests, and results.
- Create, read, list, search, archive, delete, and fork Threads.
- Apply turn, tool, approval, form, subagent, checkpoint, and terminal
  operations as append-only Thread items.
- Provide idempotency through client event IDs.
- Project status, activity, runs, checkpoints, and timeline events from stored
  items.
- Persist local Threads through a canonical journal and a queryable SQLite
  projection.
- Adapt Thread-backed state to existing session-shaped reads where required.

## Main types

- `WorkerThreadRpc`: capability-checked service used by Worker RPC and desktop
  commands.
- `ThreadStore`: persistence contract for Thread records and items.
- `LocalThreadStore`: journal-backed local implementation.
- `MemoryThreadStore`: deterministic in-memory implementation for tests and
  isolated callers.
- `LiveThread`: bound handle for appending items and updating one Thread.
- `ThreadRuntime`: translates runtime operations into canonical Thread items.
- `ThreadOp`: typed state transition accepted by `thread.apply_op`.

## Data flow

```text
typed request / ThreadOp
        |
        v
WorkerThreadRpc --> ThreadRuntime --> LiveThread --> ThreadStore
                                               |
                                               v
                          canonical journal + SQLite projection
```

`ThreadRuntime` does not keep a second mutable run state. It derives snapshots,
run summaries, status, pending interactions, and activity from the canonical
record and item stream.

## Internal layout

- `types/`: domain records, items, events, activity, and request/result shapes.
- `runtime.rs`: maps turn and runtime operations to canonical items.
- `live_thread.rs`: convenience handle bound to a Thread ID.
- `local_store/`: local persistence, queries, projections, consistency, and
  repair. See [its storage README](local_store/README.md).
- `session_adapter.rs`: session-compatible projections and merging with
  direct-session records.

## Invariants

- Thread history is append-oriented. Derived metadata changes use explicit
  metadata updates rather than rewriting historical items.
- A client event ID makes the corresponding mutation idempotent; retries must
  return the existing result instead of appending duplicates.
- Parent/child relationships are explicit and fork/archive policies must state
  whether children are included.
- Runtime status, activity, checkpoints, approvals, and agent-run views are
  projections from canonical items.
- Capability checks occur before reading or mutating persisted Thread state.
- Compatibility projections must not become an alternate canonical write
  path.
- Persistence divergence requires an explicit migration or repair operation.

For command names and frontend-visible Thread payloads, see
[the Rust backend API reference](../../../docs/api/rust-backend-api.md).
