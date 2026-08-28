# Tauri Events
<!-- tinybot-doc-watch:
src-tauri/src/agent/runtime_protocol/event_catalog.rs
src-tauri/src/agent/runtime_protocol/timeline_projection.rs
src/app-core/chat/chatTurnContracts.ts
src/app-core/native/desktopNativeTauriEvents.ts
src/app-core/native/desktopNativeTauriEvents.test.ts
-->
<!-- tinybot-doc-fingerprint: sha256:d220fb3338c15549a9d9e7250e34e44fafc2785d9e4d553137112f1bfb728f61 -->

This document lists frontend-visible events emitted by the native runtime. It
is part of the [Rust backend API reference](rust-backend-api.md), which defines
the shared invocation conventions and source-backed freshness policy for this
reference set.

## Tauri Event Names

The Rust backend emits live native-agent events through Tauri. Source names containing dots are
normalized to colon-separated Tauri listener names; for example, `agent.delta` is emitted as
`agent:delta`. The current source-name catalog is:

| Category | Source event names |
| --- | --- |
| Turn and control | `agent.turn.started`, `agent.phase.changed`, `agent.status`, `agent.guidance`, `agent.command.acknowledged` |
| Context and hooks | `agent.context.hydrated`, `agent.context.compacted`, `agent.context.trimmed`, `agent.context.compaction_failed`, `agent.hook.decision`, `agent.checkpoint` |
| Model output | `agent.reasoning_delta`, `agent.reasoning.completed`, `agent.delta`, `agent.message.phase`, `agent.message.classified`, `agent.message.completed`, `agent.model_call.completed`, `agent.token_count`, `agent.usage` |
| Tools and product items | `agent.tool_call.delta`, `agent.tool.start`, `agent.tool.result`, `agent.tool.debug`, `agent.tool.cleanup_timeout`, `agent.plan.progress`, `agent.task_progress`, `agent.awaiting_form`, `agent.form.resolution`, `agent.file.reference` |
| Terminal | `agent.done`, `agent.error`, `agent.cancelled`, `agent.cleanup_timeout` |
| Delegates | `agent.delegate.linked`, `agent.delegate.started`, `agent.delegate.running`, `agent.delegate.wait`, `agent.delegate.result`, `agent.delegate.notification`, `agent.delegate.queried`, `agent.delegate.user_message`, `agent.delegate.message_queued`, `agent.delegate.spawned`, `agent.delegate.message`, `agent.delegate.completed`, `agent.delegate.cancelled`, `agent.delegate.closed`, `agent.delegate.failed`, `agent.delegate.interrupted`, `agent.delegate.resumed`, `agent.delegate.spawn_rejected`, `agent.delegate.trace.updated` |
| Timeline projection | `agent.timeline.patch` |

The desktop shell also emits:

| Tauri event | Payload |
| --- | --- |
| `desktop-menu-command` | `{ id: string }` for a native application-menu command |
| `desktop-update-status` | `DesktopUpdateSnapshot` after each update phase or download-progress change |
| `browser:snapshot` | `BrowserNativeSnapshot` |
| `browser:diagnostic` | `BrowserRuntimeDiagnostic` |

Semantic runtime events retain their existing compatibility fields and also include a typed
`payload.agentItem` object. The discriminator is `type`. Current production projections cover
form requests/responses, task-plan progress, subagent activity,
context compaction/trimming, errors/cancellation, usage updates, and user file/image references.
Runtime event `itemId` is derived from the same typed item ID, so live delivery, trace persistence,
and replay refer to one semantic item. Unknown or malformed internally constructed semantic events
fail at the projection boundary instead of being persisted as an incomplete item.

`agent.timeline.patch` is the product-facing live update and is produced by the same projector as
the runtime-state snapshot:

```json
{
  "schemaVersion": "tinybot.timeline_patch.v2",
  "sessionId": "websocket:chat-1",
  "turnId": "turn-1",
  "snapshotRevision": 3,
  "item": {}
}
```

The frontend applies patches by turn ID and item ID. A revision gap triggers an authoritative
snapshot reload and reapplication of the received patch. If the reload still cannot close the gap,
the error remains visible. Identity/schema mismatches, invalid assistant-phase transitions,
post-final work, and terminal-state regressions are rejected;
lower item revisions are ignored with a diagnostic. Raw events remain available for traces but are
not a second Chat state source.

`thread.task_progress.upsert` requires non-empty `threadId` and `turnId` values plus the same
complete `steps` snapshot, and persists the resulting `plan_progress` item under `_agent_item`.
Counter-only payloads are rejected; provided counters and current-step values must match the
backend-derived values. `thread.append_messages` likewise requires `threadId` and `turnId` and
writes the Turn identity into every persisted message. User
message content parts of type `file`, `input_file`,
`image_url`, or `input_image` emit one `agent.file.reference` event per reference; image references
use `referenceKind: "image"` and file references use `referenceKind: "file"`.

`agent.usage` payloads preserve provider-returned OpenAI-compatible usage fields such as
`prompt_tokens`, `completion_tokens`, and `total_tokens`. The Rust agent runtime also appends
context-window budget fields to the typed `payload.agentItem`, while
`payload.agentItem.providerPayload` retains only the original provider usage. Durable
Rollouts omit redundant outer enriched copies. Replay of earlier compact usage Items restores
missing context-window fields from the adjacent `agent.token_count` record; that record also
remains authoritative for normalized cache and reasoning counters.

- `context_window_tokens` / `contextWindowTokens`: effective per-model context window from the
  turn, provider profile, known-model catalog, legacy unknown-model fallback, or backend default.
- `context_window_used_tokens` / `contextWindowUsedTokens`: provider `total_tokens` when present,
  then provider prompt/input usage, otherwise the local request estimate.
- `context_window_remaining_tokens` / `contextWindowRemainingTokens`: remaining context budget.
- `estimated_context_tokens` / `estimatedContextTokens`: local approximate token count for the
  messages, instructions, and provider-visible tool definitions sent after context-window
  trimming.
- `context_window_strategy` / `contextWindowStrategy`: effective strategy, currently `discard` or
  `compact`.
- `percent`: context-window usage percentage.

Rust agent context-window controls are resolved from the turn, active provider profile, known-model
catalog, and legacy Agent defaults:

- Turn `contextWindowTokens` / `context_window_tokens`: an explicit override for that turn.
- Profile `modelContextWindows`: per-model overrides containing `model` and
  `contextWindowTokens`. When unset, `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, and
  `deepseek-v4-pro`, plus `glm-5.3` and `glm-5.3-flash`, use `1000000` automatically.
- `agents.defaults.contextWindowTokens` / `context_window_tokens`: legacy fallback for unknown
  models only. Unknown models fall back to `128000` when it is absent.
- `contextWindowStrategy` / `context_window_strategy`: `discard` or `compact`. The fallback is
  `compact`.
- `compactTriggerPercent` / `compact_trigger_percent`: percentage threshold for `compact`; default
  `90`.
- `compactSummaryMaxTokens` / `compact_summary_max_tokens`: max completion tokens for the internal
  summary request; default `1024`.

`discard` keeps the newest messages that fit the window. `compact` sends older messages through an
internal non-streaming `chat/completions` request, stores exactly one marked assistant summary, and
keeps recent messages. Provider adapters project that internal summary as a user continuation. The
summary request uses the same async timeout, cancellation, and typed failure path as the main
provider request; failure is explicit and does not silently fall back to `discard`.

Tauri listeners receive the event-specific payload directly, not a
`NativeBackendEvent` wrapper. When the runtime event has correlation data, the backend adds it as
`payload.traceContext` before emitting. `agent:timeline:patch` likewise receives the
`AgentTimelinePatch` value shown above.

```ts
import { listen } from "@tauri-apps/api/event";

const unlisten = await listen("agent:delta", ({ payload }) => {
  console.log(payload);
});
```
