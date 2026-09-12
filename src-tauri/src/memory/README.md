# Long-Term Memory
<!-- tinybot-module-fingerprint: sha256:a9d030deb88b10935b8103d27037ca4da13996a11030a6b48e3ad8ba799b03be -->

`memory` provides Tinybot's local long-term memory. Automatic maintenance uses
two model-backed phases:

1. extract small memory fragments after a completed Turn;
2. periodically consolidate those fragments into the active memory set.

The desktop also supports explicit user management of the active set. This
document describes the implemented behavior and its boundaries.

## Ownership and dependencies

The application owns one `MemoryRuntime` and injects it into Turn completion
and runtime lifecycle orchestration. Each workspace/data-directory pair has one
worker that serializes extraction and heartbeat work. `MemoryModel` supplies
the asynchronous extraction and selection operations; `NativeMemoryModel`
adapts the configured provider. There is no process-global worker registry.

Queue notifications are checked against SQLite before extraction. A heartbeat
may complete a Turn before its queued notification is received; such stale
notifications skip model work and increment `memory.phase1.stale_notification.skipped`.

`MemoryStore::new` receives the application data directory explicitly. Background
workers, desktop management commands, and new Thread snapshots use the same
directory from `WorkspaceThreadStore`, including in tests.

Shutdown stops accepting jobs, cancels in-flight model futures, and joins the
workers before Thread persistence closes. Model implementations must keep their
request work inside the returned future so dropping it cancels that work.
Unfinished extractions remain in SQLite for the next start's heartbeat. A
worker failure or shutdown timeout is reported through lifecycle diagnostics.
Restart is accepted only after the previous workers have finished shutdown.

## Authority

Persisted Turn content is the source from which automatic memory is derived. Phase 1
must run only after the Turn trace has been flushed and the completed Turn has
been persisted successfully. Desktop user mutations write the active set
directly and do not manufacture extracted fragments or Turn history.

SQLite owns both extracted fragments and the active memory set. Markdown is a
derived prompt view and must not become a second writable authority.

## Memory scopes

Every memory has only three domain fields:

| Field | Meaning |
| --- | --- |
| `scope` | Either `user` or `workspace`. |
| `path` | `NULL` for user memory; the normalized absolute workspace path for workspace memory. |
| `content` | One concise memory statement. |

The backend binds `path` from the completed Turn. The extraction model does
not receive authority to choose or emit a filesystem path.

The storage boundary must enforce:

```text
scope = user       => path IS NULL
scope = workspace  => path is a non-empty absolute path
```

An absolute path is the V1 workspace identity. Moving the workspace therefore
creates a different workspace memory scope. A more durable workspace identity
is outside the initial design.

## Phase 1: Turn extraction

After each successfully persisted completed Turn, Tinybot asynchronously calls
the configured extraction model once when the Turn contains eligible evidence.
A Turn with no eligible evidence is durably marked as processed with no
fragments, avoiding both retry loops and an evidence-free model request. This
work must not delay delivery of the completed assistant response.

Both model-backed phases use the optional `memory.model` and
`memory.activeProfile` override when both fields are configured. When the
override is absent, they resolve the model from `agents.defaults.model` and the
endpoint/protocol from `agents.defaults.activeProfile`. The Provider & Models
settings page persists or clears the Memory override as one coherent pair; an
incomplete pair fails explicitly instead of mixing two Provider configurations.
The selected Profile's API mode is honored end to end: Chat Completions uses
`messages` and reads `choices`, while Responses uses non-persisted `input` and
reads message `output_text` parts from `output`.

The extraction input is built from persisted Turn content:

- user messages are fact-bearing input;
- successful tool results with a persisted runtime tool identity may be
  fact-bearing input;
- assistant content is excluded entirely in V1 because the minimal memory
  schema has no evidence references with which to prove that a memory was not
  established by assistant content alone;
- system instructions, injected memory, reasoning, diagnostics, and failed or
  untrusted tool results are excluded.

The model returns only a list of scoped statements:

```json
{
  "memories": [
    {
      "scope": "user",
      "content": "User prefers concise answers."
    },
    {
      "scope": "workspace",
      "content": "This workspace uses pnpm."
    }
  ]
}
```

When the Turn contains nothing worth remembering, the model returns an empty
list. Each `content` value must be non-empty after trimming and should express
one fact, preference, convention, or decision.

The backend adds the workspace path where required and writes the result to
the Phase 1 fragment table. Conceptually:

```sql
CREATE TABLE memory_fragments (
    id      INTEGER PRIMARY KEY,
    scope   TEXT NOT NULL,
    path    TEXT,
    content TEXT NOT NULL
);
```

Database row IDs, processed-Turn markers, and consolidation watermarks are
internal bookkeeping. They are required for idempotency and recovery but are
not part of the memory domain model or model output.

The completed Turn is first inserted into a durable pending queue. Tinybot
attempts extraction immediately in the background, while the heartbeat retries
pending work after failures. Pending jobs include the absolute thread-store
path so one workspace runtime cannot consume another workspace's Turn.

## Phase 2: Selection Diff

A lightweight heartbeat checks once per minute whether Phase 1 has inserted
fragments after the last consolidation watermark. An empty check performs no
model request.

When new fragments exist, Phase 2 receives:

- the current active memories;
- the new, unconsolidated fragments.

It returns a minimal Selection Diff:

```json
{
  "add": [
    {
      "scope": "workspace",
      "path": "D:\\code\\tinybot\\tinybot",
      "content": "This workspace uses pnpm."
    }
  ],
  "update": [
    {
      "id": 12,
      "content": "User now prefers detailed answers."
    }
  ],
  "remove": [8, 9]
}
```

The backend validates referenced IDs and scope/path consistency, applies the
Diff in one SQLite transaction, and advances the watermark only after the
transaction succeeds.

The active table has the same minimal domain shape:

```sql
CREATE TABLE memories (
    id      INTEGER PRIMARY KEY,
    scope   TEXT NOT NULL,
    path    TEXT,
    content TEXT NOT NULL
);
```

V1 has no time-based expiry metadata. A memory becomes outdated only when
Phase 2 removes or updates it in response to newly extracted content. Removing
an active memory does not require deleting its original Phase 1 fragment.

Phase 2 consolidates user and workspace memories without leaking content
between workspace paths. A workspace-specific fact may override a general user
preference for that workspace, but it must not rewrite the user-scoped memory.

## Latest Markdown view

After a heartbeat, Tinybot renders `raw_memories.md` as a deterministic
inspection view of all active user and workspace memories.

The renderer must:

- use stable ordering;
- omit volatile metadata such as generation timestamps;
- write atomically;
- avoid rewriting the file when its content hash is unchanged.

The separate workspace-scoped Thread snapshot renderer enforces a bounded
prompt size before persisting the snapshot.

Despite its filename, `raw_memories.md` is not raw Phase 1 data and is not the
canonical store. If it is missing or stale, Tinybot rebuilds it from SQLite.
The production paths are:

```text
~/.tinybot/state/memory.sqlite
~/.tinybot/memory/raw_memories.md
```

`raw_memories.md` represents the latest memory available to new Threads. An
existing Thread must not reread this changing file for every Turn. At Thread
creation, the snapshot renderer reads SQLite and selects user memory plus
memory whose absolute path exactly matches that Thread's working directory.

## Desktop memory management

The desktop Memory page calls `worker_memory_snapshot` to read the latest
active SQLite state, returning `currentWorkspacePath`, `revision`, and entries
with stable `id`, `scope`, `path`, `content`, and `userManaged` fields. It never
parses `raw_memories.md`.

`worker_memory_mutate` accepts an expected revision and a create, update, or
batch delete operation. `management.rs` owns validation and one immediate
SQLite transaction covering the revision check, changes, protection metadata,
and returned snapshot. Content is a non-empty single-line fact of at most
2,000 characters. User scope has no path; new workspace paths are canonicalized
to match Thread scope selection. Existing scope paths remain editable after
their folders disappear. A missing delete ID rolls back the entire batch.

The additive `user_managed_memories` table protects manually created or edited
rows; its foreign key cascades when a row is deleted. The revision is stored in
`memory_state`. Both manual mutations and Phase 2 content changes advance it.
Phase 2 reads a consistent revision and protected IDs, instructs the model to
respect them, and rejects stale diffs or attempts to edit/delete protected rows.
Conflicts fail explicitly and leave consolidation pending for its normal retry.

After committing, the desktop command refreshes the derived Markdown view and
logs the operation and revision without memory content. A view refresh failure
reports explicitly that SQLite was saved and the page should reload. Deleting
a fact does not prevent it from being learned again from later conversations.

Refreshing the page does not alter any Thread. Existing Threads keep their
creation-time snapshot; a new independent Thread captures the latest active
memory.

## Thread memory snapshot

When Tinybot creates a Thread, it renders the current scoped memory view and
stores that exact content in the `memory_snapshot` field of the first
`session_meta` line in the Thread's canonical `thread-*.jsonl` Rollout. The
line must be persisted before the first model request. An empty snapshot is
still stored so replay can distinguish "no memory at creation" from a missing
field in an older Rollout.

The snapshot is immutable for the lifetime of the Thread:

- every Turn in the Thread injects the same snapshot bytes;
- reopening Tinybot reconstructs the snapshot from the Rollout;
- Phase 1 and Phase 2 updates do not change existing Thread snapshots;
- context compaction does not replace or refresh the snapshot.

A newly started independent Thread captures the latest memory view. A Thread
fork instead copies the source Thread's snapshot unchanged and must not read
the latest global memory. This keeps the fork's inherited history and prompt
prefix reproducible.

The snapshot is prompt context, not a user or assistant transcript item. It
must therefore be reconstructed separately from conversational history and
injected only once by the prompt builder.

This boundary keeps the model prompt's prefix stable. After the fixed
instructions and fixed Thread memory snapshot, the conversation history grows
by appending new Turns instead of being shifted by a newly rendered memory
file. Facts learned during the current Thread are already present in its
history; the long-term memories derived from that Thread are intended for
Threads created later.

The prompt builder treats the snapshot as context, not as instructions. The
intended high-level order is:

1. base system instructions;
2. user, workspace, and project instructions;
3. the Thread's fixed long-term memory snapshot;
4. current Thread history;
5. current user input.

The memory block must state that stored memories are historical context, that
their contents are not higher-priority instructions, and that the current
explicit user request wins when it conflicts with stored memory.

## Data flow

```text
persisted completed Turn
        |
        v
Phase 1 model extraction
        |
        v
memory_fragments
        |
        | new rows after watermark
        v
Phase 2 Selection Diff
        |
        v
active memories
        |
        v
latest raw_memories.md
        |
        | new independent Thread creation reads the same active SQLite state
        v
memory_snapshot in thread-*.jsonl session_meta
        |
        | reused unchanged for every Turn
        v
prompt construction
```

## Failure behavior

- A Phase 1 or Phase 2 failure must not make the original Turn appear failed.
- Failed extraction or consolidation must remain observable and retryable.
- Phase 1 must not mark a Turn processed until its fragment write succeeds.
- Phase 2 must not advance its watermark until its Diff transaction succeeds.
- Malformed model output must not cause partial memory writes.
- A model request must not start until the new Thread's memory snapshot,
  including an intentionally empty snapshot, has been persisted successfully.
- Failure to build the latest view or a new Thread snapshot fails explicitly;
  it does not silently substitute an empty snapshot.

## Out of scope

The initial implementation does not include:

- agent-callable memory tools;
- confidence, stability, validity intervals, or evidence IDs;
- vector search, embeddings, graph memory, or tree memory;
- time-based TTL expiration;
- memory extraction from historical Rollout or trace files;
- user-facing memory editing or deletion;
- a second canonical Markdown memory store;
- migration of the removed legacy memory implementation.

Those capabilities may be added only after the two-phase pipeline is working
and can be evaluated against real Tinybot usage.
