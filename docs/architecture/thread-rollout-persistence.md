# Thread and Rollout Persistence
<!-- tinybot-doc-watch:
src-tauri/README.md
src-tauri/src/agent/bridge/README.md
src-tauri/src/runtime/README.md
src-tauri/src/threads/domain/README.md
src-tauri/src/threads/domain/mod.rs
src-tauri/src/threads/rollout/store/README.md
src-tauri/src/threads/rollout/store/mod.rs
src-tauri/src/threads/workspace_store.rs
-->
<!-- tinybot-doc-fingerprint: sha256:2b327ecdb454f1008352dac23f17c4dae182f31913e254ec5c340084314763aa -->

Tinybot separates typed conversation behavior from canonical storage. The
Thread domain provides the in-process Interface; the append-only Rollout is the
durable authority from which Thread, Turn, Item, context, checkpoint, and
timeline projections are reconstructed.

## Domain hierarchy

```text
Thread
  +-- Turn
        +-- Item
```

- A Thread is the durable conversation container.
- A Turn begins with one user request and owns the resulting work until pause
  or terminal state.
- An Item is one ordered input or output within a Turn. Messages, reasoning,
  tool calls, tool results, plans, forms, and usage are distinct Item kinds.
- A Message is only model-visible conversational content; it is not a synonym
  for every Item or runtime event.

## Authority and projections

```text
typed Thread operation
    |
    v
WorkspaceThreadStore operation seam
    |                         |
    |                         +--> append canonical Rollout
    v                                      |
MemoryThreadStore projection               v
                                   deterministic reconstruction
                                              |
                                              +--> Thread projection
                                              +--> model context
                                              +--> checkpoints
                                              +--> timeline and usage
```

The process-local Thread index and `MemoryThreadStore` are derived projections.
They improve lookup and typed access but cannot become alternate durable write
paths.

## Storage lifecycle

Canonical Rollouts live under the Tinybot application data root, independently
of the content workspace:

```text
~/.tinybot/threads/<year>/<month>/<day>/thread-*.jsonl[.zst]
~/.tinybot/archived_threads/<year>/<month>/<day>/thread-*.jsonl[.zst]
```

Writes append typed lines in order. Explicit persist, flush, and shutdown
barriers own filesystem durability. Startup rebuilds the process-local index
and typed Thread projection from Rollouts before accepting new Agent work.
Named legacy migrations may run during startup; unexpected divergence is a
visible failure or explicit repair operation.

## Runtime event persistence

Lossless runtime events are projected into canonical Items before diagnostic
redaction or truncation. Blocking status boundaries and Turn exits are durable
barriers. Ordinary events may be appended in bounded batches while preserving
their causal order, identity, timestamp, and sequence.

Live desktop patches and reloaded timeline snapshots must converge on the same
Item identities. Renderer state is never used to reconstruct canonical
conversation history.

Provider API modes share the same Rollout envelope. A Thread pins its provider
mode so configuration changes do not silently reinterpret existing history.
Protocol-specific response records are projected at the persistence seam while
the user-facing Thread history remains protocol-neutral.

## Recovery and consistency

- Startup reconciles persisted active Turns and marks orphaned work
  interrupted while retaining resumable waiting state.
- Index inconsistency is reported and repaired from canonical Rollouts.
- Replay is deterministic and does not mutate its input log.
- Client event IDs make retried typed mutations idempotent.
- Unknown semantics that affect replay correctness fail explicitly instead of
  being discarded.

## Invariants

- Rollouts are canonical and append-only.
- Every persisted conversation Item belongs to exactly one Turn.
- Historical Items are not rewritten to update derived metadata.
- Memory and index projections remain reconstructable from Rollouts.
- Runtime and persistence identities remain stable across live and replayed
  projections.
- Conversation authority does not live in SQLite, renderer state, or an
  in-memory journal.

## Source modules and verification

- [Backend persistence map](../../src-tauri/README.md)
- [Thread domain](../../src-tauri/src/threads/domain/README.md)
- [Rollout store](../../src-tauri/src/threads/rollout/store/README.md)
- [Native runtime services](../../src-tauri/src/runtime/README.md)
- [Backend interface reference](../api/rust-backend-api.md)
