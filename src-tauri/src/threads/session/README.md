# Worker Session

`threads::session` defines Tinybot's session-shaped projection used by
direct-session flows and compatibility callers. Conversation history,
metadata, task progress, checkpoints, and agent-turn records are reconstructed
from canonical Rollouts.

The module root is `mod.rs`; this directory splits the aggregate by concern.

## Storage model

Conversation and runtime state is not stored in a session database. The
durable authority is the append-only Rollout owned by `threads::rollout::store`.

Session-shaped reads and mutations go through Rollout adapters so validation,
capability checks, timestamps, and reconstruction stay aligned. The removed
`sessions/sessions.sqlite` store is neither read nor written.

## Responsibilities

- Project, patch, clear, branch, archive, and delete session-shaped Rollout
  state.
- Append, trim, clear, and reconstruct session message history.
- Query agent-turn summaries, traces, runtime state, and checkpoints from
  Rollout.
- Project user profiles and task progress from Rollout records.
- Enforce session ID validation and session read/write capabilities.

## Internal layout

- `types.rs`: session compatibility shapes.
- `projection.rs`: maps canonical Rollout reconstruction into session-shaped
  responses.

## Boundaries with Thread persistence

- Typed Thread lifecycle and item semantics belong in `threads::domain`.
- Canonical Rollout recording, reconstruction, indexing, and repair belong in
  `threads::rollout::store`.
- Session API compatibility belongs here, but conversation writes still append
  to the same Rollout authority.

## Invariants

- Session mutations validate IDs and capabilities before touching state.
- Conversation mutations append to Rollout; persistence errors are returned to
  the caller.
- Checkpoints are cleared only by explicit completion, cancellation, restore,
  or session-clear behavior.
- Compatibility projections must preserve message, Turn, checkpoint, and usage
  identity fields.
- Do not add a session snapshot database, fallback read, or completed-turn
  double write.
