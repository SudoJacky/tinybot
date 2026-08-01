# Worker Thread Log

`threads::rollout::store` owns Tinybot's canonical append-only Rollout. It validates
paths, records typed lines, reconstructs Thread and runtime projections,
and maintains a process-local Thread index for discovery and runtime lookup.

`threads::domain` is the live typed projection of this authority. It must not
introduce a durable journal, database, fallback read, or completed-turn double
write.

## Storage model

| Path | Role |
| --- | --- |
| `~/.tinybot/threads/<year>/<month>/<day>/thread-*.jsonl[.zst]` | Active canonical per-Thread Rollout |
| `~/.tinybot/archived_threads/<year>/<month>/<day>/thread-*.jsonl[.zst]` | Archived canonical per-Thread Rollout |

A log begins with `ThreadMeta` and can contain event messages, strongly typed
response items, turn context, world state, compaction records, and inter-agent
communication.
Canonical reconstruction produces Thread items, Thread history, model context,
agent turns, checkpoints, and token usage.

## Provider API mode

`ThreadMeta.session_meta.api_mode` pins each Thread to `chat_completions` or
`responses`. Older Rollouts without this field are read as `chat_completions`.
Changing provider configuration does not silently change an existing Thread's
mode; start a new Thread to switch APIs.

Both modes keep the same JSONL envelope. Chat Completions persists the existing
canonical message/tool projection. Responses additionally persists every raw
provider `response.output` item and local `function_call_output`, so a later turn
can replay the exact stateless input. User-facing history still exposes the
canonical message projection; `thread.context` includes raw response items only
for the agent runtime.

## Responsibilities

- Generate and validate canonical log paths under the application data root,
  independently of the Agent's content workspace.
- Append complete JSON lines and flush them before reporting success.
- Replay log history without mutating the source log.
- Project replayed state into typed Thread history and runtime context shapes.
- Maintain the `ThreadStateIndex` used for listing and lookup.
- Rebuild the process-local index from canonical logs at startup.
- Detect and repair divergence between the live index and canonical Rollouts.
- Reconcile persisted agent turns during runtime startup.

## Internal layout

- `../format/`: versioned Rollout lines, typed items, and shared replay.
- `rollout_writer.rs`, `recorder.rs`: ordered append, flushing, path validation,
  archive/delete, and compression-aware IO.
- `reader.rs`: bounded line reads.
- `reconstruction.rs`: canonical Thread and runtime projection.
- `projection.rs`: Thread history and model-context projection.
- `state_index.rs`: process-local Thread metadata, checkpoint, and Rollout-head index.
- `turn.rs`: agent-turn persistence and recovery over log/index state.
- `mod.rs`: capability-checked service and index consistency/repair behavior.

## Invariants

- Rollouts are canonical; the process-local Thread index is always derived.
- Paths must remain under `~/.tinybot/threads`; caller-provided paths are
  validated before reads or appends.
- Startup migrates the former `<workspace>/.tinybot/{threads,archived_threads}`
  layout without overwriting conflicts. The migrated Rollouts populate the
  in-memory index.
- Log lines are appended, not edited in place.
- Reconstruction is deterministic and side-effect free.
- Index inconsistency is reported. Startup and the explicit repair path rebuild
  the in-memory index from canonical Rollouts.
- Archived state, titles, previews, token usage, and timestamps in the index
  must be derivable from canonical logs.
- Unknown or malformed persisted semantics return structured errors rather
  than being silently discarded when they affect replay correctness.
- Diagnostic agent trace may be bounded, but canonical messages, completed
  reasoning, tool calls, and tool outputs are materialized from the lossless
  runtime event first and never reconstructed from truncated text.
- Streaming deltas, phase changes, and non-blocking status updates remain live
  presentation events. Blocking status boundaries remain persisted for
  recovery. One completed reasoning ResponseItem is persisted per model call.
- Ordinary canonical runtime events are durably appended in batches of up to
  64 events or 50 milliseconds. Blocking status and turn/continuation exit
  remain explicit synchronous durability barriers.
- A trace batch is appended as one recorder transaction and response-backed
  projection replays the Rollout at most once for the whole batch.
- `AddItems` only stages ordered lines in the writer. `Persist`, `Flush`, or
  `Shutdown` owns the file write/flush barrier; an append must not auto-flush
  and then immediately flush again through `Persist`.
- Repeating an identical full Thread record is a metadata no-op and must not
  append another snapshot.

## Timeline projection and replay

Rollout ordinals define runtime-event order. A projected timeline item keeps the
source event position as `sequence`; updates advance `revision` without changing
that sequence. `snapshotRevision` advances only for canonical timeline
mutations, so live patches are contiguous even when diagnostic events occur
between them.

Assistant-message and reasoning identities are scoped to one provider/model
call. Provider IDs are retained when available; otherwise the projector derives
a stable ID from the provider attempt or iteration. Deltas coalesce only into
that matching item, preserving commentary and reasoning that occurred around
tool calls.

Thread-owned runtime-event records persist the canonical item identity.
Reconstruction of older records recovers assistant and reasoning identity from
their message or reasoning ID, with a typed model-call fallback. It must not use
the per-event Thread item ID for streamed content because that would split each
delta into a different timeline item after reload.

Historical projection uses the exact event index plus Turn and item identity.
An identity mismatch is an error rather than a nearest-match fallback.
Snapshots observed after the requested boundary are excluded. Disposable replay
checkpoints are keyed by projector version and event index; incompatible data is
discarded and rebuilt from the canonical Rollout.

See [`threads::domain`](../../domain/README.md) for the typed Thread domain.
