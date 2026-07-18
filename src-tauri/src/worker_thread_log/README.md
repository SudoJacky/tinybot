# Worker Thread Log

`worker_thread_log` owns Tinybot's canonical append-only Rollout. It validates
paths, records typed lines, reconstructs Thread/session/runtime projections,
and maintains a rebuildable SQLite index for discovery and startup recovery.

`worker_thread` and `worker_session` are projections of this authority. They
must not introduce a durable journal, database, fallback read, or completed
turn double write.

## Storage model

| Path | Role |
| --- | --- |
| `.tinybot/threads/<year>/<month>/<day>/thread-*.jsonl` | Canonical per-thread append-only log |
| `.tinybot/state/state.sqlite` | Queryable index of thread/session metadata |

A log begins with `ThreadMeta` and can contain event messages, response items,
  turn context, world state, compaction records, and inter-agent communication.
Canonical reconstruction produces Thread items, session history, model
context, agent runs, checkpoints, and token usage.

## Responsibilities

- Generate and validate canonical log paths under the workspace thread root.
- Append complete JSON lines and flush them before reporting success.
- Replay log history without mutating the source log.
- Project replayed state into typed Thread and session compatibility shapes.
- Maintain the `ThreadStateDb` index used for listing and lookup.
- Detect missing, unreadable, or divergent indexes.
- Rebuild the index explicitly from canonical logs.
- Reconcile persisted agent runs during runtime startup.

## Internal layout

- `worker_rollout/`: versioned Rollout lines, typed items, and shared replay.
- `rollout_writer.rs`, `recorder.rs`: ordered append, flushing, path validation,
  archive/delete, and compression-aware IO.
- `reader.rs`: bounded line reads.
- `reconstruction.rs`: canonical Thread/session/runtime projection.
- `state_db.rs`: SQLite index schema and queries.
- `session_adapter.rs`: session compatibility projection.
- `agent_run.rs`: agent-run persistence and recovery over log/index state.
- `mod.rs`: capability-checked service and index consistency/repair behavior.

## Invariants

- Rollouts are canonical; `state.sqlite` is an index that can be rebuilt.
- Paths must remain under `.tinybot/threads`; caller-provided paths are
  validated before reads or appends.
- Log lines are appended, not edited in place.
- Reconstruction is deterministic and side-effect free.
- Index inconsistency is reported. Rebuild occurs only through the explicit
  repair path or a named startup migration for a missing legacy index.
- Archived state, titles, previews, token usage, and timestamps in the index
  must be derivable from canonical logs.
- Unknown or malformed persisted semantics return structured errors rather
  than being silently discarded when they affect replay correctness.

See [`worker_thread`](../worker_thread/README.md) for the typed Thread domain and
[`worker_session`](../worker_session/README.md) for session-shaped projections.
