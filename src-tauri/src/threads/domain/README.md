# Worker Thread
<!-- tinybot-module-fingerprint: sha256:4cf597162c150314021af1ae3ed8d0b4cc80e5c7bede6fb30d4ca8dff42396f2 -->

`threads::domain` is Tinybot's typed conversation domain. It defines Thread
records, Turns, Items, lifecycle operations, active-Turn projections, and the
in-process projection used by Thread-owned flows.

The durable authority is the Rollout owned by
[`threads::rollout::store`](../rollout/store/README.md). This module deliberately
keeps typed Thread behavior separate from canonical persistence and runtime
projection details.

## Responsibilities

- Define typed Thread records, metadata, items, events, requests, and results.
- Create, read, list, search, archive, delete, and fork Threads.
- Apply turn, tool, form, subagent, checkpoint, and terminal
  operations as append-only Thread items.
- Provide idempotency through client event IDs.
- Project status, activity, Turns, checkpoints, and timeline events from stored
  items.
- Accept typed projections reconstructed from canonical Rollout records.
- Provide an in-memory projection for typed operations without creating a
  second durable authority.

## Main types

- `WorkerThreadRpc`: capability-checked service used by Worker RPC and desktop
  commands.
- `ThreadStore`: typed mutation/query boundary for Thread records and items.
- `MemoryThreadStore`: in-process projection hydrated from Rollout state.
- `LiveThread`: bound handle for appending items and updating one Thread.
- `ThreadRuntime`: translates runtime operations into canonical Thread items.
- `ThreadOp`: typed state transition accepted by `thread.apply_op`.

## Data flow

```text
typed request / ThreadOp
        |
        v
WorkspaceThreadStore operation
        |
        +--> WorkerThreadRpc / ThreadRuntime --> MemoryThreadStore mutation
        |
        +--> canonical Rollout persistence
                         |
                         v
              projection synchronization
                         |
                         v
                 MemoryThreadStore
```

`ThreadRuntime` does not own durable state. Snapshots, Turn summaries, status,
pending interactions, and activity must remain reconstructable from the
canonical Rollout. `WorkspaceThreadStore` coordinates the in-memory service and
Rollout store under one operation boundary.

## Internal layout

- `types/`: domain records, items, events, activity, and request/result shapes.
- `runtime.rs`: maps turn and runtime operations to canonical items.
- `live_thread.rs`: convenience handle bound to a Thread ID.
- `store/`: in-memory storage plus query and activity projection helpers.

## Invariants

- Thread history is append-oriented. Derived metadata changes use explicit
  metadata updates rather than rewriting historical items.
- Every persisted `ThreadItem` belongs to exactly one Turn and therefore has a
  non-empty `turnId`. Thread-level metadata changes do not create turnless
  Items.
- A client event ID makes the corresponding mutation idempotent; retries must
  return the existing result instead of appending duplicates.
- Parent/child relationships are explicit and fork/archive policies must state
  whether children are included.
- Runtime status, activity, checkpoints, and agent-turn views are
  projections from canonical Rollout items.
- Replayed runtime events preserve their persisted event ID, sequence, and
  timestamp; assistant message phases must remain causally valid per item.
- Capability checks occur before reading or appending Thread state.
- A model-generated title applies only to the first user Turn of a non-archived
  Thread and never overwrites a title marked as manual.
- `MemoryThreadStore` must not gain a journal or database.
- Compatibility projections must not become an alternate canonical write path.

For command names and frontend-visible Thread payloads, see the
[Threads and memory API](../../../../docs/api/threads-and-memory.md).
