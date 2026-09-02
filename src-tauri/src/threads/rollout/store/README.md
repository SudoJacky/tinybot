# Worker Thread Log
<!-- tinybot-module-fingerprint: sha256:0ab0172bd574374238767e7ab45fe64ec61dcfda40c6a7b47d0592b9f9ec7ee0 -->

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

A log begins with `SessionMeta` (re-exported here as `ThreadMeta`) and can
contain event messages, strongly typed response items, turn context, world
state, compaction records, and inter-agent communication.
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

Responses reasoning completion is also persisted as a lightweight semantic
timeline event before the provider-native output batch arrives. Reconstruction
uses that event for the user-visible reasoning item and suppresses the matching
native reasoning fallback by model-call identity; the raw item remains unchanged
in model replay history.

Tool outputs may also carry a local-only `tinybot_result` sidecar when a desktop
projection needs structured data that the model-visible `output` cannot express,
such as a patch preview. Responses replay strips this field before sending
`function_call_output` back to the provider. Shell results do not use the
sidecar: their compact structured `output` is the single durable representation.
Executor permission snapshots and live stdout chunk buffers are not copied into
the durable tool-output item.

`protocol_projection.rs` owns this protocol-specific persistence mapping. In a
Responses Thread, the native `function_call` from `response.output` is the
durable tool-call record. The later runtime `agent.tool_call.delta` is accepted
as already represented only when a `function_call` with the same `call_id` is
already present (or precedes it in the same batch). An orphan lifecycle event is
a protocol error; the store does not turn arbitrary empty projections into a
successful append.

## Responsibilities

- Generate and validate canonical log paths under the application data root,
  independently of the Agent's content workspace.
- Append complete JSON lines and flush them before reporting success.
- Replay log history without mutating the source log.
- Rehydrate context metrics in historical compact usage Items from their adjacent
  canonical token-count event.
- Project replayed state into typed Thread history and runtime context shapes.
- Maintain the `ThreadStateIndex` used for listing and lookup.
- Rebuild the process-local index from canonical logs at startup.
- Reuse Rollout lines and canonical reconstruction across startup index,
  projection, and turn-recovery consumers while the Rollout head is unchanged.
- Detect and repair divergence between the live index and canonical Rollouts.
- Reconcile persisted agent turns during runtime startup.

## Internal layout

- `../format/`: versioned Rollout lines, typed items, and shared replay.
- `rollout_writer.rs`, `recorder.rs`: ordered append, flushing, path validation,
  archive/delete, and compression-aware IO.
- `reader.rs`: bounded line reads.
- `reconstruction.rs`: canonical Thread and runtime projection.
- `projection.rs`: Thread history and model-context projection.
- `protocol_projection.rs`: Chat Completions and Responses runtime-event to
  response-item projection.
- `state_index.rs`: process-local Thread metadata, checkpoint, and Rollout-head index.
- `turn.rs`: agent-turn persistence and recovery over log/index state.
- `compression.rs`: background compression and transparent materialization of
  older Rollouts.
- `checkpoint_lock.rs`: cross-process serialization for context-checkpoint
  commits.
- `mod.rs`: capability-checked service and index consistency/repair behavior.

## Invariants

- Rollouts are canonical; the process-local Thread index is always derived.
- Paths must remain under the configured data root's `threads` or
  `archived_threads` tree; caller-provided paths are validated before reads or
  appends.
- Startup migrates the former `<workspace>/.tinybot/{threads,archived_threads}`
  layout without overwriting conflicts. The migrated Rollouts populate the
  in-memory index.
- Log lines are appended, not edited in place.
- Reconstruction is deterministic and side-effect free.
- Cached reconstruction is keyed by the current Rollout head; an append or
  replacement must cause the next reader to reconstruct from disk.
- Index inconsistency is reported. Startup and the explicit repair path rebuild
  the in-memory index from canonical Rollouts.
- Archived state, titles, previews, token usage, and timestamps in the index
  must be derivable from canonical logs.
- Unknown or malformed persisted semantics return structured errors rather
  than being silently discarded when they affect replay correctness.
- Diagnostic agent trace may be bounded, but canonical messages, tool calls,
  and tool outputs are materialized from the lossless runtime event first and
  never reconstructed from truncated text. Completed reasoning remains durable
  in both its semantic timeline record and, when provided, native replay record.
- Streaming deltas, phase changes, and non-blocking status updates remain live
  presentation events. Blocking status boundaries remain persisted for
  recovery. Reconstruction projects one completed reasoning timeline item per
  model call.
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

Rollout line order defines runtime-event replay order. A persisted canonical
runtime event retains its source `sequence` and timestamp so live patches and
reloaded snapshots project the same item identity; the Rollout ordinal and
timestamp are fallbacks for older events that do not carry those fields. Updates
advance `revision` without changing the source sequence. `snapshotRevision`
advances only for canonical timeline mutations, so live patches are contiguous
even when diagnostic events occur between them.

In Responses mode, the provider-native `function_call` remains the model replay
record. Its later `agent.tool_call.delta` is also persisted as a lightweight
timeline-identity event so reconstruction uses the live Tool call's sequence
and timestamp without duplicating the provider call in model history. Older
Rollouts without that identity event continue to use their response-item
ordinal.

Tool outputs retain their source sequence and timestamp as runtime identity
metadata, but their Rollout ordinal remains the replay position. This keeps a
completion after its matching call identity even when runtime sequence values
are numerically lower than later Rollout ordinals. Timeline snapshots preserve
the resulting application order instead of sorting again by source sequence.
For legacy response items without an explicit item ID, the fallback identity
includes the Thread, Turn, and sequence so Turn-local sequence reuse cannot
collapse items from different Turns.

Assistant-message identities are scoped to one provider/model call. Provider
IDs are retained when available; otherwise the projector derives a stable ID
from the provider attempt or iteration. Deltas coalesce only into that matching
item. A tool-only provider response with no assistant content does not create a
live-only empty item or advance `snapshotRevision`. Reasoning completion keeps
the live runtime identity in the user-facing timeline while provider-native
reasoning remains available to replay and diagnostics.

Durable usage events keep the typed usage `agentItem` and its original provider
payload. The store omits redundant outer enriched usage fields; the adjacent
canonical token-count record remains authoritative for normalized last-call and
Turn-total usage, including context-window, cache, and reasoning counters.

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
