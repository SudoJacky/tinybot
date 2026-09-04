# Threads and Memory API
<!-- tinybot-doc-watch:
src-tauri/src/desktop_commands/memory.rs
src-tauri/src/desktop_commands/project_groups.rs
src-tauri/src/desktop_commands/thread.rs
src-tauri/src/agent/runtime/provider_adapter.rs
src-tauri/src/agent/runtime/provider_adapter_reference_tests.rs
src-tauri/src/memory/model.rs
src-tauri/src/threads/domain/types/events.rs
src-tauri/src/threads/domain/types/items.rs
src-tauri/src/threads/domain/types/records.rs
src-tauri/src/threads/domain/types/requests.rs
src-tauri/src/threads/domain/store/memory.rs
src-tauri/src/threads/workspace_store.rs
src-tauri/tests/crate/threads.rs
src/app-core/chat/agentInputReference.ts
-->
<!-- tinybot-doc-fingerprint: sha256:5b2bbe59f0d8f5408363b6ea5e33bab577f39d66a5d583ba0a2dd29761ccc5af -->

This document covers Thread queries, memory, persistence, and project grouping.
It is part of the [Rust backend API reference](rust-backend-api.md), which
defines the shared invocation conventions and source-backed freshness policy
for this reference set.

## Thread Timeline Queries

The renderer queries canonical Turn summaries and runtime state through the Thread commands
documented below. These commands accept `threadId` directly.

`thread_get_turn_runtime_state` returns runtime events projected from the Thread's canonical
Rollout plus one canonical timeline snapshot for product rendering. Rollout ordinals define replay
order. Persisted canonical runtime event envelopes retain their original sequence and timestamp so
live patches and reloaded snapshots keep the same item identity; the Rollout ordinal and timestamp
are fallback values for older records that do not carry that identity. In-memory thread items are
not reconstruction sources.

```json
{
  "runtimeEvents": [],
  "timeline": {
    "schemaVersion": "tinybot.timeline.v2",
    "sessionId": "websocket:chat-1",
    "turnId": "turn-1",
    "snapshotRevision": 2,
    "items": [
      {
        "schemaVersion": "tinybot.turn_item.v2",
        "itemId": "message-1",
        "sessionId": "websocket:chat-1",
        "turnId": "turn-1",
        "sequence": 4,
        "revision": 2,
        "kind": "assistant_message",
        "status": "completed",
        "createdAt": "2026-07-11T00:00:00Z",
        "updatedAt": "2026-07-11T00:00:01Z",
        "data": {
          "type": "assistant_message",
          "messageId": "message-1",
          "modelCallId": "provider-attempt-2",
          "phase": "final_answer",
          "content": "Done"
        }
      }
    ]
  }
}
```

`item.sequence` is the source runtime-event position and never changes for an existing item.
`item.revision` advances for each mutation of that item. `snapshotRevision` counts canonical
timeline mutations only; diagnostic runtime events that do not produce an item do not advance it.
This makes live patch revisions contiguous while preserving source identity. Snapshot array order
is the authoritative replay/render order and does not need to be monotonic by source sequence.

For Responses turns, the provider-native `function_call` remains the model-history record, while
its canonical `agent.tool_call.delta` supplies the persisted timeline sequence and timestamp. This
keeps model replay deduplicated and makes a reloaded Tool item match its live identity. When an
older Rollout lacks that identity metadata, the desktop resolves a live/persisted sequence conflict
by reloading the already-flushed durable snapshot and requires it to reach the patch revision.
Tool outputs use their Rollout ordinal for replay order while retaining runtime sequence and
timestamp as identity metadata, so completion cannot be replayed before its matching call. The
projected snapshot preserves application order instead of sorting again by source sequence.

`assistant_message.data.phase` is `unknown`, `commentary`, or `final_answer`. A provider-supplied
phase is used immediately. For providers without phases, a model response followed by Tool calls is
classified as `commentary`; a terminal response without Tool calls is classified as
`final_answer`. A tool-only provider response with empty assistant content does not create a
timeline item or advance `snapshotRevision`; its Tool calls remain canonical items. Only `unknown`
may transition to a classified phase. Reclassifying commentary as a
final answer, changing a classified phase, or emitting Tool, Plan, Reasoning, Form, or
Subagent work after the final answer is a protocol error and returns a structured projection error.
These state-machine checks belong to the backend; the renderer validates schema, revision
continuity, and item identity, then renders the backend-provided order. Plan completion is not a
final-answer signal.

Textual provider reasoning is materialized in the product-facing canonical timeline. Live deltas
revise one running Reasoning item without advancing the durable snapshot revision; the completed
event advances the revision and folds into that same item. Reload prefers a provider reasoning
summary and falls back to persisted `reasoning_text` when no summary exists. Providers that return
only encrypted reasoning or token counts do not create an empty visible item.

Persisted tool outputs are normalized before timeline projection. A JSON-encoded output string is
decoded into `tool_call.data.result`, while `item.summary` is derived from a bounded human-readable
field such as `summary`, `output`, or `stdout`. The full normalized result remains available to the
detail surface without leaking the entire serialized result into the execution-step label.

Canonical `user_message` data also carries optional `clientEventId`. The desktop sends this ID in
`worker_submit_thread_turn`, and the runtime echoes it in the canonical user item. It is a
reconciliation identity and does not replace the durable `messageId`.

Typed Thread turn input may carry an optional `references` array for structured
user-attached context. The desktop composer uses the canonical reference shape
for file attachments and referenced conversations rather than embedding that
evidence into the visible message text:

```json
{
  "threadId": "thread-1",
  "input": {
    "role": "user",
    "clientEventId": "client-message-1",
    "content": "Review this file",
    "references": [
    {
      "kind": "reference",
      "title": "notes.md",
      "detail": "text/markdown · 1.2 KB",
      "referenceKind": "file",
      "rawPath": "D:/work/notes.md"
    }
    ]
  },
  "spec": {
    "turnId": "turn-1",
    "sessionId": "thread-1",
    "stream": true,
    "metadata": { "clientEventId": "client-message-1" }
  }
}
```

The Thread command preserves `references` in the Agent input and turn metadata. The thread runtime
persists them on the canonical `user_message`, so reloads keep the same visible
reference chips. Immediately before a provider request, non-image references
with a supported `referenceKind` are appended to the provider-only user content
inside an explicit untrusted-evidence block. Image references are validated and
converted into provider-native image content separately. The stored and
user-visible message content remains unchanged. Provider
injection accepts at most 16 such references and 64 KiB of serialized reference
data per message. Exceeding either limit fails the provider request visibly
rather than dropping context.

Composer `@` mentions use the same reference contract with `referenceKind: "thread"`. The desktop
limits suggestions to persisted Threads in the active Thread's normalized workspace, excludes the
active Thread, and resolves the selected Thread's latest persisted user/assistant transcript when
the message is sent. `scope` carries the referenced Thread ID, `revision` records its observed
`updatedAt` value, and `sourceText` contains a bounded transcript snapshot with an explicit omission
marker when middle content is truncated. The snapshot is provider evidence rather than an
instruction source; selecting a conversation does not merge or mutate either Thread.

Desktop chat controls call `worker_thread_interrupt` and `worker_submit_thread_form` directly. Their
canonical Thread timeline updates are delivered directly through typed Tauri events; no secondary
transport-frame projection is part of the desktop contract.

The native `thread_get_effective_capabilities` command returns
`tinybot.effective_capabilities.v2` decisions keyed by `threadId`.
Unavailable decisions include both `reasonCode` and a user-facing `reason`; the response identifies
the evaluated turn used for the decision when present. The response contains
only the Chat controls `agent.cancel` and `agent.retry`. Retry is available only
when the latest turn failed and no active turn supersedes it; cancellation is
available for a running turn and for a paused legacy turn that still appears in
persisted state. Filesystem, terminal, browser, pause/resume, and request-change
capabilities are not projected through this Chat contract.

Product-facing canonical item data includes the following lifecycle details:

- `form`: `formId`, `fieldIds`, `status`, optional `action`, submitted `values`, and validation
  `errors`. The canonical item owns lifecycle/result state; the Agent UI form registry remains the
  authority for interactive field definitions.
- `plan_progress`: optional `explanation`, the complete typed `steps` snapshot, and backend-derived
  `completed`, `total`, and optional `currentStep`.
- `context_compaction`: `droppedItemCount` plus optional `estimatedTokensBefore` and
  `estimatedTokensAfter`.
- `file_reference`: stable `id`, `path`, optional `mimeType`, and `referenceKind`. `parentItemId`
  associates the reference with its owning Tool, Form, or Subagent item.
- `subagent_lifecycle`: stable `agentId`, `action`, and `status`; optional `childTurnId`,
  `childThreadId`, `parentAgentId`, `parentTurnId`, `name`, `task`, `message`, and `traceRef` retain
  the backend-authored parent and assigned-work correlation used by Agent process groups.
  Missing relationships remain absent and are not inferred from labels.
- `error`: `code`, `message`, and `cancelled`. An error with `parentItemId` is scoped to its owner;
  errors without a parent remain terminal timeline rows.

`agent.context.compacted`, `agent.context.trimmed`, and `agent.usage` are durable semantic events.
`thread_get_turn_runtime_state` reconstructs them after an application restart, and historical
context checkpoints without a stored semantic event still project as a `context_compaction` item.
Desktop session loads refresh the canonical turn runtime states instead of reusing an indefinitely
cached timeline. Until a later provider usage item exists, the current context indicator combines
the latest compaction's `estimatedTokensAfter` with its canonical `contextWindowTokens`; older
items without that field fall back to the most recent known usage budget, then to the currently
loaded Agent Defaults context-window budget. Canonical compaction data also preserves `strategy` so
the restored indicator matches the live context policy.

Manual and automatic compaction share one replacement-history policy. Current system/developer
instructions and recent user messages are retained within the context budget; assistant messages,
tool calls, tool results, and any previous compaction summary are replaced by exactly one marked
assistant summary (`contextCompaction: true`). Provider adapters project that internal summary as a
continuation user message without exposing the marker. `agent.context.compacted` reports
`preservedUserMessageCount`, `droppedUserMessageCount`, `droppedAssistantMessageCount`,
`droppedToolMessageCount`, and `mergedCompactionSummaryCount` alongside the existing token and
message counts.

The desktop loads Subagent traces and artifact content through
`worker_background_trace_get_delegate_trace` and `worker_background_trace_get_artifact`. Timeline
paths are metadata only and are never used directly as browser image URLs. Raster previews accept
only backend-returned base64 `data:image` content for PNG, JPEG, GIF, or WebP; SVG and arbitrary
URLs remain inert text/metadata.

## Long-Term Memory

Long-term memory is backend-owned automation. The desktop renderer has one read-only Tauri command,
`worker_memory_snapshot`; there is no Worker RPC namespace, WebUI route, agent-callable tool, or
renderer mutation path.

Phase 1 extraction and Phase 2 consolidation use `memory.activeProfile` and `memory.model` when
both are configured. If neither is configured, both phases dynamically follow
`agents.defaults.activeProfile` and `agents.defaults.model`. Provider & Models writes or clears the
override as a pair; a partial override is an explicit configuration error.
Each phase uses the selected Profile's configured API mode for its request, transport, and response
parsing: Chat Completions uses `messages`/`choices`, while Responses uses non-persisted
`input`/`output`.

| Tauri command | Params | Result |
| --- | --- | --- |
| `worker_memory_snapshot` | none | `{ currentWorkspacePath, userMemories, workspaces }` |

The command reads the canonical active set directly from SQLite and returns user memories plus
workspace groups. Each workspace group includes `path`, `current`, and `memories`; the current
workspace is present even when its active set is empty. It does not parse the derived Markdown
view. Refreshing this snapshot only changes the inspection page: existing Threads continue using
their immutable creation-time memory snapshot.

| Path | Authority |
| --- | --- |
| `~/.tinybot/state/memory.sqlite` | Authoritative fragments and active memories |
| `~/.tinybot/memory/raw_memories.md` | Derived inspection view; never parsed for prompts |
| `~/.tinybot/{threads,archived_threads}/YYYY/MM/DD/thread-*.jsonl[.zst]` | Immutable memory snapshot used by each Thread |

Thread creation renders the current user memories plus memories whose workspace path exactly
matches the Thread's effective working directory. The result is capped at 12,000 characters and
stored, including when empty, in the first Rollout's `session_meta.memory_snapshot` field before the
first model request. A fork copies the source Thread's snapshot. Existing Threads therefore keep a
stable prompt prefix and do not observe later memory changes. Extraction, Selection Diff, scope,
retry, and failure behavior are documented in `src-tauri/src/memory/README.md`.

## Thread and Turn Persistence

All conversation and runtime state has one persistence authority: typed, append-only Rollout files.
Active Threads live under `~/.tinybot/threads/YYYY/MM/DD/thread-*.jsonl`; archived Threads use the
matching hierarchy under `~/.tinybot/archived_threads/`. Cold Rollouts may be stored as
`thread-*.jsonl.zst`; this is a transparent physical representation of the same logical Rollout and
is materialized before a later append.
Thread discovery metadata, checkpoint pointers, and Rollout heads are maintained only in memory and
rebuilt from those files when the process starts.

`thread.create` pins the Thread's provider API mode in `metadata.extra.apiMode` and the Rollout
session metadata. When `metadata.extra.modelProvider` explicitly selects a provider, that provider's
profile determines the mode; otherwise creation falls back to the active provider profile. Later
turns must use the pinned mode, and a mismatch fails before the provider is called.

The durable hierarchy is strict: a Thread may exist without an active Turn, but every persisted
`ThreadItem` and every Turn checkpoint has one non-empty `turnId`. Thread-level metadata updates made
while no Turn is active update Thread metadata without manufacturing a turnless Item. A Rollout
record that would project to a Thread item without a Turn identity is a consistency error.

After the first user Turn is durably started, a default-titled Thread may receive a generated title
from a separate tool-free request using that Turn's Provider and model. The metadata update carries
the source Turn ID and is applied under the `WorkspaceThreadStore` operation lock only when it still
matches the first user Turn, the Thread is not archived, and no manual title owns the field.
Successful generated titles set `metadata.extra.titleSource` to `model`; manual metadata updates set
it to `manual` and always win. This update changes Thread metadata only and does not create a
turnless Item.

The title request uses the initiating Turn's effective API mode, streaming choice, temperature,
output-token budget, reasoning settings, service tier, and Provider request adaptation. It replaces
the conversation prompt with the bounded title system/user prompt and exposes no tools or prior
history. Tinybot does not impose a separate title output-token limit or timeout: an omitted user
budget uses the Provider default, and the Provider Profile owns request and stream-idle timeouts.

Turn writes follow Codex-style ordering: one start batch contains `turn_started`, `turn_context`,
the materialized system/developer prompt when it changed, and the user message. Later batches append
typed message/tool/reasoning records, a per-provider-call `token_count` when the provider reports
usage, resumable checkpoints, and one `turn_complete` or `turn_aborted`. Compaction, metadata
changes, rollback, fork, archive, and
subagent communication use the same Rollout authority. UI thread snapshots, thread history, model
context, AgentTurn records, and active checkpoints are reconstructed projections of that file.
Canonical append or reconstruction errors fail the operation instead of falling back to an old
store.

Native agent lifecycle persistence is fail-fast: a terminal-turn lookup or turn-start write failure
returns a command error before the provider is called, and a turn-record write failure returns a
command error instead of embedding a failed persistence diagnostic in an otherwise successful
result.

For native turns with a live desktop sink, runtime deltas, phase/status changes, and UI
patches remain live-only. Stable semantic events enter a bounded ordered queue and are materialized
through `thread.turn.append_semantic_batch` as typed Rollout records. Tool-call confirmation, tool
output, usage, error, cancellation, and terminal boundaries flush the relevant batch before the
runtime crosses that boundary. Queue or flush failure fails the command explicitly. Reload projects
the authoritative timeline only from typed durable records; live event sequence never advances the
durable Rollout revision.
Thread-owned commands such as `worker_submit_thread_turn` and `worker_submit_thread_form` append
their runtime events, turn state, resumable checkpoint, forms, and final assistant or error items
directly to the canonical Rollout. The native
agent result is not replayed through `thread.apply_op`, so each logical value has one canonical
payload. The turn-start seed retains instruction provenance and diagnostics, so derived
`thread.turn.get` projections preserve the effective working directory and instruction sources.
Form continuation restores `latestCheckpoint.restorePayload` from Rollout, including
after a new runtime instance starts; a later terminal item makes that checkpoint inactive.

`clientEventId` is the retry/idempotency key for thread appends, starts, continuations,
forms, and forks. A successful retry projects the original item IDs instead of appending another
logical operation.

Persistence verification and repair are lower-level Worker RPC methods:

| Method | Params | Behavior |
| --- | --- | --- |
| `thread.persistence.check` | `{}` | Compare canonical Rollouts, their heads, reconstructed records/checkpoints, and the process-local Thread index. |
| `thread.persistence.repair` | `{ mode: "migrate_legacy_projection" | "rebuild_projection" }` | Both accepted modes rebuild the in-memory index from canonical Rollouts. |

Startup and first access initialize the in-memory index automatically. Normal reads do not invoke
the explicit repair RPC. Consistency status values are `clean`, `missing_index`, `diverged`, and
`unreadable`.

`thread.history` returns the persisted message projection and `thread.context` returns the model
context projection. When a thread has token usage, the
backend derives the message `usage` field from the latest persisted `token_count` event. A malformed
thread log line, malformed `token_count` event, or malformed compaction payload is treated as a
backend error instead of being silently ignored.

`thread.resolve` accepts `{ identity }` and resolves an exact Thread ID or UI session key through
the process-local Thread index. It does not scan or mutate Rollouts after startup reconstruction.

## Project Group Commands

Project groups are stored independently from Thread Rollouts and only contain a display name and
canonical workspace membership. Saving validates that every workspace currently exists and is a
directory. Deleting a group removes only the membership record and never deletes workspace files,
Git repositories, or retained Threads.

| Command | Args | Result |
| --- | --- | --- |
| `worker_project_groups_list` | none | `{ groups: ProjectGroup[] }` |
| `worker_project_group_save` | `{ input: { projectGroupId?, name, workspaceIds } }` | `ProjectGroup` |
| `worker_project_group_delete` | `{ input: { projectGroupId } }` | deleted `ProjectGroup` |

`ProjectGroup` is `{ projectGroupId, name, workspaceIds }`. A workspace can belong to more than one
project group. Project-scoped workspace sessions and coordinator sessions persist
`metadata.extra.projectGroupId`; existing sessions without that field remain standalone and are not
implicitly duplicated into every group that references their directory.

## Thread Commands

Thread Tauri commands all use `{ input: { body } }`, except the continuation helper commands listed separately.

| Command | Worker RPC method | Body |
| --- | --- | --- |
| `worker_thread_create` | `thread.create` | `CreateThreadRequest` |
| `worker_thread_read` | `thread.read` | `ReadThreadRequest` |
| `worker_thread_resume` | `thread.resume` | `ResumeThreadRequest` |
| `worker_threads_list` | `thread.list` | `ListThreadsRequest` |
| `worker_thread_search` | `thread.search` | `SearchThreadsRequest` |
| `worker_thread_activity` | `thread.activity` | `ThreadActivityRequest` |
| `worker_thread_status` | `thread.status` | `{ threadId }` |
| `worker_thread_update_metadata` | `thread.update_metadata` | `UpdateThreadMetadataRequest` |
| `worker_thread_agent_registry` | `thread.agent_registry` | `ThreadAgentRegistryRequest` |
| `worker_thread_start_turn` | `thread.start_turn` | `StartThreadTurnRequest` |
| `worker_thread_continue_turn` | `thread.continue_turn` | `ContinueThreadTurnRequest` |
| `worker_thread_interrupt` | `thread.interrupt` | `InterruptThreadRequest` |
| `worker_thread_apply_op` | `thread.apply_op` | `ThreadApplyOpRequest` |
| `worker_thread_archive` | `thread.archive` | `ArchiveThreadRequest` |
| `worker_thread_unarchive` | `thread.unarchive` | `ArchiveThreadRequest` with `archived: false` |
| `worker_thread_delete` | `thread.delete` | `DeleteThreadRequest` |
| `worker_thread_fork` | `thread.fork` | `ForkThreadRequest` |
| `worker_thread_events` | `thread.events` | `ThreadEventsRequest` |
| `worker_thread_restore_checkpoint` | `thread.restore_checkpoint` | `RestoreThreadCheckpointRequest` |
| `thread_list_turns` | `thread.turn.list` | `{ threadId }` |
| `thread_get_turn_runtime_state` | `thread.turn.runtime_state` | `{ threadId, turnId }` |
| `thread_get_effective_capabilities` | composite Thread capability query | `{ threadId }` |

`thread.turn.runtime_state` returns the canonical turn lifecycle (`status`, `completedAt`, and `stopReason`) together with `runtimeEvents` and `timeline`. Consumers must use the turn lifecycle as the terminal-state authority; a completed standalone operation such as manual context compaction does not need to synthesize an assistant final-answer item.

Thread continuation helper commands:

| Command | Args |
| --- | --- |
| `worker_submit_thread_turn` | `{ input: { threadId?: string, input: unknown, spec?: unknown } }` |
| `worker_submit_thread_form` | `{ input: { threadId, formId, values?, action? } }` |
| `worker_compact_thread` | `{ input: { threadId, clientEventId? } }` |

Agent checkpoint continuation supports structured forms only.

`worker_compact_thread` creates a standalone manual-compaction turn. Historical messages are input
to the compaction algorithm, not new user input: the turn does not emit `agent.turn.started` and its
turn-start record does not materialize the last historical user message again. Successful completion
is represented by the canonical `context_compaction` item; failure remains an explicit backend error.

The renderer prepares the final user text before calling `worker_submit_thread_turn`. When the user
mentions files, it prepends their absolute paths to that text; the backend persists and forwards the
message verbatim and does not copy attachment files. The agent reads a mentioned file through
`exec_command`. The supported input shape is:

```json
{
  "role": "user",
  "content": "# Files mentioned by the user:\n\n## notes.md: C:\\work\\notes.md\n\n## My request for Tinybot:\nReview the file."
}
```

The renderer sends the composer's effort choice as `spec.reasoningEffort`. Composer values are `low`,
`medium`, `high`, `xhigh`, and `max`; a missing or invalid local preference starts at `high`. Model
support varies, and an unsupported explicit value remains a provider request error rather than being
silently downgraded.

`ThreadRecord`:

```json
{
  "threadId": "thread-1",
  "title": "New session",
  "status": "idle",
  "sessionKey": "websocket:chat-1",
  "rootTurnId": "turn-1",
  "activeTurnId": null,
  "parentThreadId": null,
  "source": "desktop",
  "createdAt": "...",
  "updatedAt": "...",
  "archivedAt": null,
  "metadata": {
    "summary": null,
    "preview": null,
    "tags": [],
    "model": null,
    "workingDirectory": null,
    "itemCount": 0,
    "turnCount": 0,
    "hasActiveTurn": false,
    "extra": {}
  }
}
```

`ThreadSnapshot`:

```json
{
  "thread": {},
  "items": [],
  "turns": [],
  "activeTurn": null,
  "latestCheckpoint": null,
  "children": [],
  "turnItems": [],
  "childActivities": [],
  "pagination": {
    "cursor": "0",
    "limit": 100,
    "itemCount": 0,
    "previousCursor": null,
    "nextCursor": null,
    "hasMoreBefore": false,
    "hasMoreAfter": false
  },
  "nextCursor": null
}
```

Thread statuses:

- `empty`
- `idle`
- `running`
- `waiting_for_input`
- `cancelling`
- `failed`
- `archived`
