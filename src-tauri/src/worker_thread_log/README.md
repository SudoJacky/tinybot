# Worker Thread Log

`worker_thread_log` owns the append-only JSONL log used by session-compatible
conversation persistence. It validates log paths, records typed log lines,
replays them into session history, and maintains a SQLite index for list/search
operations and startup recovery.

This is distinct from the typed `worker_thread` store. The two surfaces can be
projected together for compatibility reads, but they have different schemas,
paths, and repair operations.

## Storage model

| Path | Role |
| --- | --- |
| `.tinybot/threads/<year>/<month>/<day>/thread-*.jsonl` | Canonical per-thread append-only log |
| `.tinybot/state/state.sqlite` | Queryable index of thread/session metadata |

A log begins with `ThreadMeta` and can contain event messages, response items,
turn context, world state, compaction records, and inter-agent communication.
`replay_thread` reduces supported lines into `ThreadReplay`, including session
messages and token usage.

## Responsibilities

- Generate and validate canonical log paths under the workspace thread root.
- Append complete JSON lines and flush them before reporting success.
- Replay log history without mutating the source log.
- Project replayed state into session metadata/history shapes.
- Maintain the `ThreadStateDb` index used for listing and lookup.
- Detect missing, unreadable, or divergent indexes.
- Rebuild the index explicitly from canonical logs.
- Reconcile persisted agent runs during runtime startup.

## Internal layout

- `types.rs`: versioned log lines, metadata, replay, usage, and index records.
- `recorder.rs`: path validation and append-only JSONL writes.
- `reader.rs`: bounded line reads.
- `replay.rs`: deterministic reduction of log lines to conversation history.
- `state_db.rs`: SQLite index schema and queries.
- `session_adapter.rs`: conversion to session metadata/history.
- `agent_run.rs`: agent-run persistence and recovery over log/index state.
- `mod.rs`: capability-checked service and index consistency/repair behavior.

## Invariants

- JSONL logs are canonical; `state.sqlite` is an index that can be rebuilt.
- Paths must remain under `.tinybot/threads`; caller-provided paths are
  validated before reads or appends.
- Log lines are appended, not edited in place.
- Replay is deterministic and side-effect free.
- Index inconsistency is reported. Rebuild occurs only through the explicit
  repair path or a named startup migration for a missing legacy index.
- Archived state, titles, previews, token usage, and timestamps in the index
  must be derivable from canonical logs.
- Unknown or malformed persisted semantics return structured errors rather
  than being silently discarded when they affect replay correctness.

See [`worker_thread`](../worker_thread/README.md) for the typed Thread domain and
[`worker_session`](../worker_session/README.md) for session-shaped state.
