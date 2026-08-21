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
<!-- tinybot-doc-fingerprint: sha256:67349a807aabbd2f126988b14249db3d145becece151e9291db9ee97b5eb0471 -->

Tinybot separates typed conversation behavior from canonical storage. The
Thread domain provides the in-process interface; the append-only Rollout is the
durable authority from which Thread, Turn, Item, context, checkpoint, and
timeline projections are reconstructed.

## Domain hierarchy

```text
Thread
  +-- Turn
        +-- Item
```

- A Thread is the durable conversation container.
- A Turn begins with one user request and owns the resulting work until it
  waits for typed user input or reaches a terminal state.
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
~/.tinybot/chat-attachments/images/<sha256>.<ext>
```

Writes append typed lines in order. Explicit persist, flush, and shutdown
barriers own filesystem durability. Startup rebuilds the process-local index
and typed Thread projection from Rollouts before accepting new Agent work.
Named legacy migrations may run during startup; unexpected divergence is a
visible failure or explicit repair operation.

Managed image files are content-addressed supporting data, not a second
conversation log. The originating user-message Item stores a `tinyos.image`
reference containing its managed path, MIME type, byte size, and content hash.
Provider request construction validates those fields against the file and
temporarily Base64-encodes the bytes; the encoded payload is never appended to
the Rollout.

## Runtime event persistence

Persistable semantic runtime events are projected into canonical Items before
diagnostic redaction or truncation. Blocking status boundaries and Turn exits
are durable barriers. Eligible events may be appended in bounded batches while
preserving their causal order, identity, timestamp, and sequence; streaming
deltas and non-blocking status updates remain live-only.

Live desktop patches and reloaded timeline snapshots must converge on the same
Item identities. Renderer state is never used to reconstruct canonical
conversation history. Legacy response records without an explicit Item ID use
a fallback containing the Thread, Turn, and sequence so equal Turn-local
sequences cannot collapse across Turns.

Provider API modes share the same Rollout envelope. A Thread pins its provider
mode so configuration changes do not silently reinterpret existing history.
Protocol-specific response records are projected at the persistence seam while
the user-facing Thread history remains protocol-neutral.

Graph Agent nodes use this exact store. Each invocation creates a parentless
Thread with `source: "agent_graph"` and Graph, Run, node, and node-run IDs in
`metadata.extra`; Chat filters that source while explicit Thread APIs and
diagnostics retain normal access.

Lifecycle command hooks do not introduce a second conversation store. Prompt
hooks run only after the Turn start is durable; an explicit hook denial follows
the normal terminal persistence path. Dynamic hook context may be present in a
resumable context checkpoint, while hook definitions and trusted hashes remain
application/workspace configuration outside Rollouts.

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
- [Threads and memory API](../api/threads-and-memory.md)
