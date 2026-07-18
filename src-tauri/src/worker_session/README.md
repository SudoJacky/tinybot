# Worker Session

`worker_session` exposes Tinybot's session-shaped API used by direct-session
flows and compatibility callers. Conversation history, metadata, task
progress, checkpoints, and agent-run records are reconstructed from canonical
Rollouts; this module separately owns temporary upload resources.

The module root is [`../worker_session.rs`](../worker_session.rs). This
directory splits the aggregate by concern.

## Storage model

Conversation and runtime state is not stored in a session database. The
durable authority is the append-only Rollout owned by `worker_thread_log`.
Temporary uploads use the independent resource sidecar:

```text
.tinybot/resources/session-temporary-files.json
```

Session-shaped reads and mutations go through Rollout adapters so validation,
capability checks, timestamps, and reconstruction stay aligned. The removed
`sessions/sessions.sqlite` store is neither read nor written.

## Responsibilities

- Project, patch, clear, branch, archive, and delete session-shaped Rollout
  state.
- Append, trim, clear, and reconstruct session message history.
- Query agent-run summaries, traces, runtime state, and checkpoints from
  Rollout.
- Project user profiles and task progress from Rollout records.
- Manage temporary-file metadata and lifecycle.
- Enforce session ID validation and session read/write capabilities.

## Internal layout

- `types.rs`: session and temporary-file compatibility shapes.
- `resource_store.rs`: durable temporary-resource sidecar.
- `temporary_file.rs`: temporary upload records and cleanup.

## Boundaries with Thread persistence

- Typed Thread lifecycle and item semantics belong in `worker_thread`.
- Canonical Rollout recording, reconstruction, indexing, and repair belong in
  `worker_thread_log`.
- Session API compatibility belongs here, but conversation writes still append
  to the same Rollout authority.
- Temporary resource cleanup must accompany session clear/delete without
  treating the resource sidecar as conversation history.

## Invariants

- Session mutations validate IDs and capabilities before touching state.
- Conversation mutations append to Rollout; persistence errors are returned to
  the caller.
- Checkpoints are cleared only by explicit completion, cancellation, restore,
  or session-clear behavior.
- Temporary files have explicit ownership and cleanup; they are not ordinary
  durable message attachments.
- Compatibility projections must preserve message, run, checkpoint, and usage
  identity fields.
- Do not add a session snapshot database, fallback read, or completed-turn
  double write.
