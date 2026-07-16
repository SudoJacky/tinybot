# Worker Session

`worker_session` owns Tinybot's session-shaped aggregate used by direct-session
flows and compatibility callers. It stores session metadata plus associated
history, profiles, task progress, temporary files, checkpoints, and agent-run
records.

The module root is [`../worker_session.rs`](../worker_session.rs). This
directory splits the aggregate by concern.

## Storage model

`WorkerSessionRpc` can be in-memory or persistent. Persistent instances store
session snapshots at:

```text
<session-root>/sessions/sessions.sqlite
```

The session record remains an aggregate: several compatibility fields live in
its `extra` object. Mutations go through `WorkerSessionRpc` so validation,
capability checks, timestamps, and persistence stay aligned.

Thread-backed conversations are exposed to session callers through adapters in
`worker_thread::session_adapter` and `worker_thread_log::session_adapter`.
Those adapters do not make the session database canonical for typed Threads.

## Responsibilities

- Create, list, patch, clear, branch, and delete session metadata.
- Append, trim, clear, and project session message history.
- Persist and query agent-run summaries, traces, runtime state, and checkpoints.
- Store user profiles and task-progress snapshots.
- Manage temporary-file metadata and lifecycle.
- Enforce session ID validation and session read/write capabilities.

## Internal layout

- `types.rs`: session, history, checkpoint, run, task, and temporary-file
  shapes.
- `metadata.rs`, `metadata_helpers.rs`: aggregate loading, mutation, SQLite
  snapshots, and validation.
- `history.rs`, `history_helpers.rs`, `turn_persistence.rs`: message and turn
  persistence.
- `agent_run.rs`, `checkpoint.rs`: run records, trace pages, runtime state, and
  resumable checkpoints.
- `profile.rs`, `task_progress.rs`, `task_progress_helpers.rs`: user/session
  metadata projections.
- `temporary_file.rs`: temporary upload records and cleanup.
- `common.rs`: shared validation, timestamps, capability checks, and errors.

## Boundaries with Thread persistence

- New typed Thread lifecycle and item semantics belong in `worker_thread`.
- Per-thread session-compatible JSONL recording and replay belong in
  `worker_thread_log`.
- Session API compatibility, direct-session aggregates, and their optional
  SQLite snapshot belong here.
- Cross-store reads should be merged in the existing adapters/facades, not by
  copying one store into another during a read.
- A write must target the store that owns the caller's durable identity.

## Invariants

- Session mutations validate IDs and capabilities before touching state.
- Persistent mutations update the aggregate and then persist it; persistence
  errors are returned to the caller.
- Checkpoints are cleared only by explicit completion, cancellation, restore,
  or session-clear behavior.
- Temporary files have explicit ownership and cleanup; they are not ordinary
  durable message attachments.
- Compatibility projections must preserve message, run, checkpoint, and usage
  identity fields.
- Do not add new typed Thread semantics to the session `extra` object merely to
  avoid extending the Thread model.
