# Rust Backend API Reference

Source snapshot: `3ed968b1`

This document describes the API surfaces exposed by the Rust/Tauri backend in `src-tauri`.
It is intended for frontend callers and integrators who need command names, invocation
patterns, response envelopes, and the current Rust-owned route inventory.

## Surfaces

The Rust backend is reachable through four surfaces:

1. Tauri commands registered in `src-tauri/src/desktop/bootstrap.rs`.
2. `worker_webui_route`, a Tauri command that emulates HTTP/WebUI routes and returns an HTTP-like response envelope.
3. Worker RPC methods handled by `WorkerRpcRouter`.
4. Tauri events emitted for live agent/runtime updates.

Most desktop frontend code should prefer typed wrappers under `src/app-core/native/*`.
Direct `invoke()` calls are still documented here because they are the actual backend contract.

## Tauri Invocation Contract

Use Tauri's `invoke` API:

```ts
import { invoke } from "@tauri-apps/api/core";

const threads = await invoke("worker_threads_list", {
  input: { body: {} },
});
```

General rules:

- Commands without an input struct are invoked with no second argument.
- Most worker commands accept `{ input: ... }`.
- Field names use `camelCase` at the Tauri boundary because the Rust input structs use `#[serde(rename_all = "camelCase")]`.
- A successful command resolves to the serialized Rust return value.
- A command returning `Result<T, String>` rejects with the string error if Rust returns `Err`.

## Common Error Shapes

Direct Tauri commands mostly fail as a rejected `invoke()` promise with a string message.

`worker_webui_route` does not reject for ordinary route errors. It returns:

```json
{
  "status": 500,
  "body": {
    "error": {
      "message": "error text"
    }
  },
  "headers": {
    "x-tinybot-route-owner": "rust",
    "x-tinybot-route-group": "workspace"
  }
}
```

Worker RPC uses this response envelope:

```json
{
  "protocol_version": "1",
  "id": "req-1",
  "trace_id": "trace-1",
  "result": {},
  "error": {
    "code": "worker_error",
    "message": "worker crashed",
    "details": {},
    "retryable": true,
    "source": "worker"
  }
}
```

Known worker error codes:

- `invalid_protocol`
- `incompatible_protocol_version`
- `capability_denied`
- `worker_error`

Known worker error sources:

- `rust_core`
- `worker`

## Native Runtime Lifecycle

The Rust backend is an in-process Native Runtime. Tauri setup starts it before the renderer uses
typed commands, and window close or updater installation runs its bounded shutdown path. There are
no renderer commands for managing a separate backend process, and the runtime cannot be configured
to remain alive after the App exits.

The internal lifecycle state records native-runtime recovery and cleanup. Startup pauses new agent
continuations while the process-local Thread index is rebuilt from canonical Rollouts and checked for
consistency. The startup report keeps the compatibility fields `sessionLogIndex` and
`sessionLogIndexMigration`; they describe an in-memory projection, not a persistent SQLite index.
Missing, divergent, or unreadable in-memory state is rebuilt automatically at startup. An explicit
`thread.persistence.repair` call is needed only when the already-initialized process observes a
later Rollout/index mismatch. A persisted `running` turn with no live owner is then closed as
`status: "interrupted"`, `phase: "interrupted"`, and
`stopReason: "runtime_restarted"`; waiting turns and their checkpoints remain unchanged. A storage
error leaves the task runtime non-accepting, sets `last_error`, and appends a
`startup_recovery` diagnostic instead of silently continuing.

## File Dialog Commands

| Command | Args | Response |
| --- | --- | --- |
| `pick_upload_file` | `{ options: { title?: string, filters?: { name: string, extensions: string[] }[] } }` | `null` when cancelled, or `{ name, path, mime_type, size_bytes, bytes }` |
| `pick_chat_files` | `{ options: { title?: string, filters?: { name: string, extensions: string[] }[] } }` | `[]` when cancelled, or `{ name, path, mimeType, sizeBytes }[]`; file bytes are not loaded |
| `pick_workspace_directory` | `{ options: { title?: string } }` | `null` when cancelled, or the selected absolute UTF-8 path |
| `save_export_file` | `{ options: { title?: string, defaultPath?: string, filters?: Filter[], contents: string } }` | `null` when cancelled, or `{ path }` |
| `reveal_workspace_file` | `{ path: string }` | `void` |

`reveal_workspace_file` only accepts these workspace-relative paths:

- `AGENTS.md`
- `SOUL.md`
- `SYSTEM.md`
- `USER.md`
- `TOOLS.md`
- `HEARTBEAT.md`

`SYSTEM.md` is the editable native-agent system-prompt template. The backend creates it once when
missing and reloads it for each workspace-backed turn. Supported placeholders are `{{identity}}`,
`{{working_directory}}`, and `{{operating_system}}`. Empty templates, unknown placeholders, and
malformed delimiters fail explicitly. `{{working_directory}}` resolves to the turn `cwd` (or thread
`metadata.workingDirectory`) rather than the directory that stores Tinybot state.

Before each workspace-backed turn, the native runtime composes one ordered instruction stream with
source provenance. Increasing precedence is:

1. built-in Tinybot identity (`100`);
2. explicit turn `developerInstructions` (`200`);
3. editable workspace `SYSTEM.md` (`300`);
4. optional workspace `SOUL.md`, `USER.md`, and `TOOLS.md` (`400`, `410`, `420`);
5. project `AGENTS.md` scopes from the nearest `.git` root to the effective working directory
   (`500 + depth`), with `AGENTS.override.md` replacing `AGENTS.md` at the same scope;
6. the Thread's fixed long-term-memory snapshot (`600`);
7. effective skill files selected explicitly or autoloaded from `always: true` metadata (`700 + index`);
8. `collaborationMode` and `agentRole` instructions (`800`, `810`);
9. generated working-directory and operating-system facts (`900`).

The long-term-memory source is historical context, not an instruction authority. Its wrapper
explicitly states that the current request wins when it conflicts with stored memory. The exact
snapshot is fixed when the Thread is created, so later global memory changes do not invalidate the
stable prompt prefix of an existing Thread.

The four turn fields may appear at the turn specification root or under `metadata`; snake_case aliases are also
accepted. `selectedSkills` is an ordered array of names. Workspace `skills/<name>/SKILL.md` wins over
the bundled `builtin-skills/<name>/SKILL.md`. Skill frontmatter is parsed as typed YAML and requires
`name` and `description`; optional `requires.bins` and `requires.env` entries determine runtime
availability. `skills.enabled: false` disables all skills, the legacy array form acts as an allowlist,
`skills.disabled_skills` excludes named skills, and `skills.autoload: true` loads available skills
with `always: true`. Invalid, disabled, unavailable, duplicate, or missing explicitly selected skill
names fail before provider dispatch. Workspace profile and skill files have a 64 KiB per-file limit,
while project instructions share a 64 KiB aggregate budget. Invalid UTF-8, unreadable paths, invalid
field types, truncation, and empty sources are surfaced instead of silently disappearing.

## Renderer Diagnostics Command

| Command | Args | Response |
| --- | --- | --- |
| `record_renderer_diagnostic` | `{ input: unknown }` | `void` |

The command serializes the supplied JSON value, records it in the process-local native runtime log,
and appends it to the persistent native backend log. A single serialized renderer entry is bounded
to 16 KiB with UTF-8-safe truncation. Log write failures reject the command.

## Desktop Update Commands

| Command | Args | Response |
| --- | --- | --- |
| `desktop_update_status` | none | `DesktopUpdateSnapshot` |
| `desktop_check_for_update` | none | `DesktopUpdateSnapshot` |
| `desktop_install_update` | `{ input: { expectedVersion: string } }` | `DesktopUpdateSnapshot` |

`DesktopUpdateSnapshot` contains `currentVersion`, optional `availableVersion`, `releaseNotes`,
`displayNotes`, and `publishedAt`, plus `phase`, optional `progressPercent`, and optional `error`.
Phases are `idle`, `checking`, `up_to_date`, `available`, `downloading`, `installing`, and `failed`.

On Windows startup, Tinybot starts a background check and stops after publishing either
`up_to_date`, `available`, or `failed`. Startup never downloads an artifact, shuts down the native
runtime, or launches an installer. Download, signature verification, runtime shutdown, and installer
launch are reachable only through `desktop_install_update`; the command rejects a stale
`expectedVersion` so a changed release must be reviewed before installation.

The updater endpoint's standard `notes` value becomes `releaseNotes`. An endpoint may also add a
top-level `display_notes` string (`displayNotes` is accepted as an alias) for a separate highlighted
instruction in the update dialog. Blank values are omitted rather than rendered.

## Config Commands

| Command | Args | Response |
| --- | --- | --- |
| `get_settings_snapshot` | none | `SettingsSnapshot` |
| `get_config_editor_snapshot` | none | `ConfigEditorSnapshot` |
| `apply_config_patch_result` | `{ result: ConfigPatchBridgeResult }` | `ConfigPatchApplyResult` |
| `apply_config_operations` | `{ request: ConfigOperationRequest }` | `ConfigPatchApplyResult` |

Config commands use `$HOME/.tinybot/config.json`. On Rust backend startup, and before each config
command loads the store, the backend ensures the config file exists. If the file is missing it creates
a schema v1 default config with:

- `schemaVersion: 1`
- `agents.defaults.activeProfile: "deepseek-default"`
- `agents.defaults.model: "deepseek-v4-pro"`
- `providers.profiles.deepseek-default` with DeepSeek V4 models and the built-in `reasoning` capability

Existing files are never overwritten by this initialization path, including invalid JSON or non-object
config files. If default creation succeeds, config snapshots include an info diagnostic with code
`DefaultConfigCreated`. If default creation fails, snapshots still return effective in-memory defaults
and include a warning diagnostic with code `DefaultConfigCreateFailed`.

Infrastructure failures reject config commands with a structured IPC payload instead of a plain
string:

```json
{
  "code": "load_config_store",
  "message": "failed to read configuration",
  "configPath": "C:\\Users\\example\\.tinybot\\config.json"
}
```

Stable `code` values are `initialize_default_config`, `load_config_store`, `apply_config_patch`,
`apply_config_operations`, and `reconcile_mcp_runtime`. Validation and revision conflicts remain
successful `ConfigPatchApplyResult` responses with `ok: false`; the structured IPC error is reserved
for failures that prevent the operation from producing a valid application result.

`SettingsSnapshot` is the Rust-owned settings control-center projection for the first settings MVP.
It is intended for frontend settings UI callers that need grouped fields, scope/source metadata,
readonly runtime status, and secret-safe field metadata without reading arbitrary raw config JSON.
Returned field paths are canonical camelCase config paths; legacy snake_case paths are accepted for
read compatibility and normalized on save.

```json
{
  "areas": [
    { "id": "core", "label": "Core" },
    { "id": "application", "label": "Application" },
    { "id": "system", "label": "System" }
  ],
  "groups": [
    {
      "id": "provider-models",
      "label": "Provider & Models",
      "area": "core",
      "fields": [
        {
          "id": "provider-profile-openai-work-api-key",
          "label": "API key",
          "path": "providers.profiles.openai-work.apiKey",
          "scope": "profile",
          "source": "secret",
          "valueType": "secret",
          "editable": true,
          "value": null,
          "secret": {
            "configured": true,
            "revealable": true,
            "copyable": true,
            "exportable": false,
            "loggable": false,
            "displayValue": "********"
          },
          "risk": "sensitive",
          "sideEffect": "none"
        }
      ]
    }
  ],
  "configPath": ".../.tinybot/config.json",
  "revision": "hash",
  "diagnostics": []
}
```

First-version group ids returned by `get_settings_snapshot`:

- `general`
- `provider-models`
- `workspace`
- `mcp-servers`
- `skills`
- `automations`
- `runtime`
- `logs-diagnostics`
- `expert-config`

The first version intentionally does not include Channels, generic
web/exec/browser tool toggles, telemetry/crash-report controls, or raw JSON editing fields.
The `runtime` group only projects native runtime metadata; it does not expose endpoint or heartbeat
configuration for a separate backend process. Secret fields
return `value: null` with `secret` metadata and must remain redacted in exported/public config.
Provider selection is profile-based. New config should use `agents.defaults.activeProfile` and
`providers.profiles.<profileId>.provider`; `agents.defaults.provider: "auto"` is a legacy value only.
The built-in provider catalog currently exposes only `deepseek`, `dashscope`, and `openai`.
Profiles are not limited to that catalog: a profile with a custom provider ID, explicit `apiBase`,
and at least one model is resolved as an OpenAI-compatible provider. Its optional API key remains on
the existing secret/redaction path, and `supportsModelDiscovery` controls `/models` discovery.
Each profile defaults to Chat Completions. Set `apiMode` to `responses` (or enable **Use Responses
API** in provider settings) only when its endpoint supports `/responses`.

OpenAI-compatible provider profiles accept separate network deadlines:

- `requestTimeoutMs` / `request_timeout_ms` / `timeoutMs` / `timeout_ms`: deadline for creating a
  non-stream response or opening a streaming response. The default is `120000` ms.
- `streamIdleTimeoutMs` / `stream_idle_timeout_ms`: maximum time between streaming chunks. It
  defaults to the resolved request timeout.

The `mcp-servers` group projects live MCP runtime state. Each configured server has readonly
`status` and `tool_count` fields populated from the Native Runtime rather than static
placeholders. Status values are `disabled`, `starting`, `ready`, `failed`, `stopping`, or `stopped`.
Streamable HTTP servers also expose endpoint, bearer-token environment-variable, static header,
environment-backed header, and timeout settings. Sensitive static headers such as
`Authorization` are returned as secret fields with `value: null`.

Provider model discovery:

- `deepseek` uses the OpenAI-compatible `GET {apiBase}/models` API. The default `apiBase` is
  `https://api.deepseek.com`, so discovery calls `https://api.deepseek.com/models`.
- `openai` uses `GET https://api.openai.com/v1/models` by default.
- `dashscope` uses the same OpenAI-compatible model discovery shape against its configured
  `apiBase`, so the default discovery URL is
  `https://dashscope.aliyuncs.com/compatible-mode/v1/models`.

`POST /api/provider-models` accepts `{ provider, profile, apiBase, refreshLive }`. When
`refreshLive: true` is used for an OpenAI-compatible provider, the backend reads the configured
profile API key server-side and merges live results into the returned `models` list with source
`live`. Missing credentials or unsupported discovery are returned as `warning` without exposing
secrets.

`ConfigEditorSnapshot`:

```json
{
  "configPath": ".../.tinybot/config.json",
  "revision": "hash",
  "explicitPublicConfig": {},
  "effectivePublicConfig": {},
  "origins": {},
  "diagnostics": [],
  "secretPresence": {}
}
```

The editor snapshot is intended for expert/debug views and public config summaries. Regular Settings
UI should prefer `SettingsSnapshot` once the frontend is migrated to the Rust-owned settings schema.

`ConfigOperationRequest`:

```json
{
  "expectedRevision": "optional-current-revision",
  "operations": [
    { "op": "replace", "path": "agents.defaults.model", "value": "deepseek-v4-pro" },
    { "op": "replace", "path": "agents.defaults.activeProfile", "value": "deepseek-default" },
    { "op": "remove", "path": "agents.defaults.timezone" },
    { "op": "secretReplace", "path": "providers.profiles.deepseek-default.apiKey", "value": "sk-..." },
    { "op": "secretRemove", "path": "providers.profiles.deepseek-default.apiKey" }
  ]
}
```

`ConfigPatchApplyResult`:

```json
{
  "ok": true,
  "config": {},
  "revision": "new-revision",
  "updatedFields": ["agents.defaults.model"],
  "sideEffects": {
    "applied": [],
    "restartRequired": [],
    "warnings": []
  },
  "error": null
}
```

## Agent Runtime

The native renderer enters the Agent Runtime through Thread-owned typed commands:
`worker_submit_thread_turn`, `worker_thread_interrupt`, and `worker_submit_thread_form`.

Workspace-backed agent results include:

- `instructionProvenance`: the effective working directory, a SHA-256 hash of the complete model
  instruction text, and ordered source records. Each source records `kind`, path identifier,
  precedence, scope root, load timestamp, source hash, truncation state, and validation warnings.
- `instructionDiagnostics`: structured warnings derived from the source records.
- `traceContext`: stable `requestId`, `traceId`, `turnId`, optional `threadId`, and optional
  `parentTurnId` values shared by runtime events and durable turn records.
- `turnMetrics`: the turn duration and terminal outcome for the completed invocation.
- `contextContributions`: ordered, content-free diagnostics for enabled context contributors. Each
  record includes `contributorId`, `kind`, `status`, `contentChars`, `contentSha256`,
  `referenceCount`, safe reference identifiers, and `truncated`.

The instruction provenance and instruction diagnostics are stored on the durable agent-turn record, so
`thread_list_turns` and `thread_get_turn_runtime_state` can explain the instruction inputs of
a historical turn without persisting a second write authority.

Contributor assembly, hooks, task ownership, cleanup, and metric internals are documented in
`src-tauri/src/agent/runtime/README.md`. `runtime.metrics` remains available through Worker RPC and
returns process-local `counters`, `durations`, and `gauges` without prompt, tool-output, or secret
content.

### Turn settings and provider capabilities

Each Turn owns an immutable settings snapshot parsed from the Turn specification, metadata, and
agent defaults. It includes model, provider, iteration and streaming limits,
temperature, maximum completion tokens, context-window strategy, reasoning options, service tier, output schema,
working directory, permission profile, selected tools, and parallel-tool policy.
Invalid values fail request construction rather than being reread differently by later stages.

Optional provider features must be declared explicitly on the selected provider profile:

```json
{
  "providers": {
    "profiles": {
      "fixture-default": {
        "provider": "fixture",
        "capabilities": {
          "serviceTier": true,
          "reasoning": true,
          "structuredOutput": true
        }
      }
    }
  }
}
```

`capabilities` may instead be an array containing `service_tier`, `reasoning`, and/or
`structured_output` (camel-case spellings are also accepted). A requested undeclared feature fails
with the resolved provider ID and missing capability. Built-in profile capabilities fall back to the
provider catalog when the profile omits the field; an explicit profile value overrides that default.
Declared settings map to Chat Completions fields as
follows: service tier to `service_tier`, reasoning effort to `reasoning_effort`, reasoning summary
configuration to `reasoning`, and output schemas to `response_format.type = "json_schema"`.

Turn-level runtime controls are also typed and validated before MCP discovery or provider dispatch:

- `workingDirectory`/`cwd` must resolve to an existing directory. Absolute paths outside the
  workspace are accepted; relative paths are resolved from the workspace root. The composed
  instruction provenance and provider context use that directory, and shell tools inherit it when
  their call does not provide `workingDir`.
- `permissionProfile` currently accepts only `local-worker`, which selects the native desktop
  capability policy. Unknown profiles fail explicitly.
- `selectedTools` is an optional exact allowlist of tool IDs or methods. Deferred selections activate
  for that turn; unknown, unavailable, or duplicate selections fail. An omitted or empty list keeps
  the normal registry.

### Cancellation response

`worker_thread_interrupt` only targets the current active turn. A supplied `turnId` must match that
turn; a stale ID or a thread without an active turn is rejected. Its response includes the owned
task transition as `taskCancellation`:

```json
{
  "runtime": "rust",
  "turnId": "turn-1",
  "cancelled": true,
  "stopReason": "interrupted",
  "task": {
    "turnId": "turn-1",
    "state": "cancel_requested",
    "reason": "user_requested",
    "activeTaskRemoved": false,
    "cleanupPending": true
  }
}
```

Possible task states are `cancel_requested`, `cancelled_waiting`, `already_terminal`, and
`not_found`. User interruption cancels the provider stream and notifies running tools to clean up.
If cooperative cleanup exceeds its grace period, the owned task is aborted and an
`agent.cleanup_timeout` diagnostic is retained, while the turn still ends as `interrupted`.
Already streamed assistant text is materialized before the terminal boundary so it remains visible
after reload. The durable Rollout boundary is `TurnAborted` with `status`, `phase`, and `stopReason`
set to `interrupted`. Provider-initiated cancellation and runtime shutdown remain `cancelled`.

### Provider failure results

Provider failures do not retry automatically and preserve distinct `stopReason` values:

- `cancelled`
- `provider_request_timeout`
- `provider_stream_idle_timeout`
- `provider_transport_error`
- `provider_error`

Timeout, transport, and provider failures emit `agent.error` with the same `stopReason`. A provider
cancellation follows the normal `agent.cancelled` path.

### Native agent turn specification

When `maxIterations` is omitted from the turn specification, metadata, and agent defaults, the native
runtime uses `200`. Explicit turn or settings values still take precedence.

```json
{
  "turnId": "turn-1",
  "sessionId": "websocket:chat-1",
  "messages": [{ "role": "user", "content": "Hello" }],
  "model": "deepseek-v4-pro",
  "maxIterations": 20,
  "stream": true,
  "developerInstructions": "Use the native runtime for this turn.",
  "selectedSkills": ["review-work"],
  "collaborationMode": "Work as the primary implementation agent.",
  "agentRole": "Own the result through verification.",
  "metadata": {}
}
```

### Deferred tool discovery and checkpoints

Browser, subagent, and MCP tools may remain deferred until selected explicitly or activated through
`tool_search` for the current Turn. Calls to inactive deferred tools fail with
`stopReason: "policy_denied"`. Form continuations revalidate the persisted activation set against
the current registry and capability policy.

### Model-requested user input

`request_user_input` creates an `awaiting_form` checkpoint and returns
`stopReason: "awaiting_form"`. `worker_submit_thread_form` must use its matching `threadId` and
`formId`; submitting resumes the same provider chain, while cancellation returns
`stopReason: "form_cancelled"`.

## Thread Timeline Queries

The renderer queries canonical Turn summaries and runtime state through the Thread commands
documented below. These commands accept `threadId` directly.

`thread_get_turn_runtime_state` returns runtime events projected from the Thread's canonical
Rollout plus one canonical timeline snapshot for product rendering. Rollout ordinals define event
order; embedded event sequence values and in-memory thread items are not reconstruction sources.

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
This makes live patch revisions contiguous while preserving source ordering.

`assistant_message.data.phase` is `unknown`, `commentary`, or `final_answer`. A provider-supplied
phase is used immediately. For providers without phases, a model response followed by Tool calls is
classified as `commentary`; a terminal response without Tool calls is classified as
`final_answer`. Only `unknown` may transition to a classified phase. Reclassifying commentary as a
final answer, changing a classified phase, or emitting Tool, Plan, Reasoning, Form, or
Subagent work after the final answer is a protocol error and fails visibly. Plan completion is not a
final-answer signal.

Provider reasoning is retained in provider-native replay records and debug runtime events, but it is
never materialized in the product-facing canonical timeline. Chat rendering therefore does not
depend on whether a provider emits reasoning summaries, raw `reasoning_text`, or no reasoning item.

Persisted tool outputs are normalized before timeline projection. A JSON-encoded output string is
decoded into `tool_call.data.result`, while `item.summary` is derived from a bounded human-readable
field such as `summary`, `output`, or `stdout`. The full normalized result remains available to the
detail surface without leaking the entire serialized result into the execution-step label.

Canonical `user_message` data also carries optional `clientEventId`. The desktop sends this ID in
`worker_submit_thread_turn`, and the runtime echoes it in the canonical user item. It is a
reconciliation identity and does not replace the durable `messageId`.

Typed Thread turn input may carry an optional `references` array for structured user-attached
context. TinyOS uses the existing canonical reference shape rather than embedding selected file or
terminal evidence into the visible message text:

```json
{
  "threadId": "thread-1",
  "input": {
    "role": "user",
    "clientEventId": "client-message-1",
    "content": "Explain this selection",
    "references": [
    {
      "kind": "reference",
      "title": "src/main.ts · L2–3",
      "detail": "TinyOS file selection",
      "type": "tinyos.file",
      "sourcePath": "src/main.ts",
      "sourceLine": 2,
      "sourceText": "let value = 1;\nreturn value;",
      "evidenceId": "item-file-1",
      "scope": "turn-1"
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
reference chips. Immediately before a provider request, references whose `type` starts with
`tinyos.` are appended to the provider-only user content inside an explicit untrusted-evidence
block; the stored and user-visible message content remains unchanged. Provider injection accepts at
most 16 TinyOS references and 64 KiB of serialized reference data per message. Exceeding either
limit fails the provider request visibly rather than dropping context.

Desktop chat controls call `worker_thread_interrupt` and `worker_submit_thread_form` directly. Their
canonical Thread timeline updates are delivered directly through typed Tauri events; no secondary
transport-frame projection is part of the desktop contract.

Pause/resume, retry, request-change, historical projection, and TinyOS reference behavior are
documented with controlled-host actions, revision guards, retained terminal execution, and shared
browser-session rules in `src/app-core/chat/tinyOs/README.md`.

The native `thread_get_effective_capabilities` command returns
`tinybot.effective_capabilities.v2` decisions keyed by `threadId`.
Unavailable decisions include both `reasonCode` and a user-facing `reason`; the response identifies
the evaluated turn used for the decision when present. Retry is available only when that latest turn
is failed and no active turn supersedes it. `files.requestChange` is available when workspace read
access is granted, the workspace root is available, and no turn is active.
The `terminal` capability group also declares `contract: "retained_execution_v1"` and
`persistentPty: false`; clients reject a different or missing execution contract instead of
silently treating it as the delivered retained-execution model.
`files.directEdit`, `files.save`, and `terminal.execute` additionally require their corresponding
desktop capability, an available workspace, and no active turn. The current native shell backend
cannot enforce denied-network execution, so `terminal.execute` fails closed with
`reasonCode: "network_enforcement_unavailable"` instead of starting a less restricted process.
`terminal.cancel` is available only
for a running `tinyos-host-terminal-*` operation. The generic Agent cancel control remains unavailable
for host operations so the owning TinyOS application remains the single control surface.
`agent.pause` is available for a running turn; `agent.resume` is available only when the evaluated
turn has `status: "waiting"` and `phase: "paused"`.

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
  the backend-authored parent and assigned-work correlation used by TinyOS Agent process groups.
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

Long-term memory is backend-owned automation. It has no Tauri command, Worker RPC namespace, WebUI
route, or agent-callable tool.

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

The durable hierarchy is strict: a Thread may exist without an active Turn, but every persisted
`ThreadItem` and every Turn checkpoint has one non-empty `turnId`. Thread-level metadata updates made
while no Turn is active update Thread metadata without manufacturing a turnless Item. A Rollout
record that would project to a Thread item without a Turn identity is a consistency error.

Turn writes follow Codex-style ordering: one start batch contains `turn_started`, `turn_context`,
the materialized system/developer prompt when it changed, and the user message. Later batches append
typed message/tool/reasoning records, per-provider-call `token_count`, resumable checkpoints, and one
`turn_complete` or `turn_aborted`. Compaction, metadata changes, rollback, fork, archive, and
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

## Skills Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_skills_list` | none | `{ skills: [...] }` or WebUI list shape |
| `worker_skills_detail` | `{ input: { name } }` | skill detail |
| `worker_skills_create` | `{ input: { body } }` | created skill |
| `worker_skills_update` | `{ input: { name, body } }` | updated skill |
| `worker_skills_delete` | `{ input: { name } }` | delete result |
| `worker_skills_validate` | `{ input: { name } }` | validation result |

These commands belong to the legacy skills API. Native agent turns discover active skills from enabled global Agent Plugins instead.

## Agent Plugin Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_plugins_list` | none | `{ plugins: PluginSummary[] }` |
| `worker_plugin_install` | `{ input: { path } }` | installed `PluginSummary` |
| `worker_plugin_prepare_migration` | `{ input: { path } }` | isolated `PluginMigrationJob` |
| `worker_plugin_set_enabled` | `{ input: { name, enabled } }` | updated `PluginSummary` |
| `worker_plugin_uninstall` | `{ input: { name } }` | `null` |

Plugin installs use the Agent Plugins 1.0.0 layout and are global under `~/.tinybot/plugins`. A new plugin is disabled by default. Enabling, disabling, replacing, or uninstalling a plugin reconciles the shared MCP runtime. Skill names exposed to turn-level selection are qualified as `<plugin-name>:<skill-name>`; plugin MCP server IDs are qualified as `plugin:<plugin-name>:<server-name>`.

Migration preparation accepts a recognized standalone Skill, MCP configuration, or client-plugin directory but does not install it. It rejects already valid Agent Plugins and unrecognized directories, copies the source without following links or reparse points into `~/.tinybot/plugins/migrations/<job-id>/source`, and creates an empty sibling `output` directory for an Agent-assisted conversion turn.

## Workspace Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_workspace_files` | none | `{ files: WorkspaceFileEntry[] }` |
| `worker_workspace_file` | `{ input: { path } }` | `WorkspaceReadFileResult` |
| `worker_workspace_put_file` | `{ input: { path, body } }` | `WorkspaceWriteResult` |
| `worker_workspace_directory` | `{ input: { path, cursor?, nameQuery? } }` | Worker response containing `WorkspaceDirectoryPage` |
| `worker_workspace_file_chunk` | `{ input: { path, cursor? } }` | Worker response containing `WorkspaceFileChunk` |

Lower-level workspace RPC also supports:

- `workspace.resolve_path`
- `workspace.read_file`
- `workspace.read_file_chunk`
- `workspace.read_bootstrap_files`
- `workspace.write_file`
- `workspace.apply_patch`
- `workspace.create_dir`
- `workspace.list_dir`
- `workspace.list_dir_page`
- `workspace.delete_file`
- `workspace.list_files`

`WorkspaceReadFileResult`:

```json
{
  "path": "README.md",
  "contents": "...",
  "content": "...",
  "updated_at": "2026-07-06T00:00:00Z",
  "content_type": "text/plain",
  "line_start": 1,
  "line_end": 100,
  "line_total": 250,
  "truncated": false
}
```

TinyOS Files uses revision-bound, paginated read commands instead of loading an unbounded workspace
tree or file. `worker_workspace_directory` returns a Worker response whose `result` has this shape:

```json
{
  "path": "src",
  "workspace_key": "D:/code/tinybot",
  "listing_revision": "...",
  "entries": [
    {
      "path": "src/app-core",
      "kind": "directory",
      "size_bytes": null,
      "updated_at": "2026-07-14T00:00:00Z"
    }
  ],
  "next_cursor": null
}
```

Directories sort before files, entries are then ordered by normalized path, and `nameQuery` filters
entry names before pagination. A continuation cursor is bound to `listing_revision`; using it after
the directory changes fails visibly with query code `listing_changed`.

`worker_workspace_file_chunk` returns a Worker response whose `result` has this shape:

```json
{
  "path": "src/main.ts",
  "content_type": "text",
  "revision": "...",
  "size_bytes": 1024,
  "updated_at": "2026-07-14T00:00:00Z",
  "content": "...",
  "line_start": 1,
  "line_end": 40,
  "next_cursor": null
}
```

Binary files return `content_type: "binary"` without invented text content or line numbers. File
continuation cursors are bound to `revision`; using one after the file changes fails visibly with
query code `source_changed`. Other workspace query failures retain their protocol error, path, and
retryable metadata rather than returning an empty successful page.

`workspace.apply_patch` accepts:

```json
{
  "patch": "*** Begin Patch\n*** Update File: README.md\n@@\n-old\n+new\n*** End Patch",
  "sessionId": "websocket:chat-1",
  "turnId": "turn-1"
}
```

The patch grammar supports `*** Add File: path`, `*** Update File: path`, and
`*** Delete File: path` operations between `*** Begin Patch` and `*** End Patch`. Update operations
also support an optional `*** Move to: path`; hunks begin with `@@` or `@@ context`, may be pure
additions, and may end with `*** End of File`. The first hunk may omit `@@` and begin directly with a
space, `+`, `-`, or blank context line. Header markers accept surrounding whitespace only while the
parser is expecting a top-level header. Inside an update body, control markers must begin in column
zero, so indented marker text remains file content. Blank lines after `*** End of File` are ignored.

Hunk lookup follows the Codex apply-patch matching order: exact, ignore trailing whitespace, ignore
surrounding whitespace, then normalize common Unicode punctuation. Tinybot additionally requires
the selected match to be unique at the winning strictness, so ambiguous patches fail instead of
silently choosing the first occurrence.

The RPC requires both `fs.workspace.read` and `fs.workspace.write`. All targets and source contents
are prepared before writing. Paths must stay inside the workspace; symlink escapes, path aliases,
and non-regular update/delete targets are rejected; add and move destinations cannot overwrite; and
a file may appear only once per patch. Limits are 4 MiB, 256 file operations, 256 hunks per updated
file, and 64 MiB per target file. Each changed file is written atomically. Updated and moved files
preserve their source permissions and existing LF or CRLF line ending.

For model-dispatched workspace tools, `workspace` means the current turn's resolved
`workingDirectory`/`cwd`. The thread store continues to use the backend persistence workspace; its
root must not be reused for file mutations when the conversation is attached to a different working
directory. Direct worker RPC callers that do not carry turn context retain their configured
workspace root.

A multi-file patch is committed in operation order and is not globally transactional. If a later
filesystem operation fails, the protocol error includes `details.committed` with the exact known
`changed_files`, `files_changed`, `hunks_applied`, and `exact` status for changes already committed;
the agent bridge retains these structured details in its surfaced error instead of dropping them.

Result shape:

```json
{
  "changed_files": [
    {
      "path": "README.md",
      "operation": "update",
      "move_path": "docs/README.md",
      "hunks": [{ "index": 1, "removed_lines": 1, "added_lines": 1 }],
      "delta": [{
        "old_start": 1,
        "new_start": 1,
        "old_lines": ["old"],
        "new_lines": ["new"]
      }],
      "delta_truncated": false
    }
  ],
  "files_changed": 1,
  "hunks_applied": 1
}
```

`delta` contains the exact matched source lines and replacement lines used by the desktop change
preview. It is capped at 2 MiB per changed file; larger previews return an empty `delta` with
`delta_truncated: true` while the patch itself still succeeds and the summary remains available.

After typed parameter, JSON-schema, capability, and availability validation,
`workspace.apply_patch`, `workspace.write_file`, `workspace.delete_file`, `shell.execute`,
`shell.start`, browser interaction, and MCP tool calls dispatch directly.

`permission_profile.evaluate_tool` still reports normalized `effects` as descriptive metadata:

```json
{
  "filesystem": {
    "readRoots": ["filesystem://unrestricted"],
    "writeRoots": ["filesystem://unrestricted"]
  },
  "network": {
    "mode": "unrestricted",
    "destinations": ["network://unrestricted"]
  },
  "process": { "execute": true, "interactive": false },
  "environment": {
    "inherit": true,
    "secretScopes": ["environment://ambient-process"]
  },
  "mcp": [],
  "mutatesSession": false,
  "mutatesBackground": false
}
```

Workspace tools use exact workspace-relative write roots where possible; strict multi-file patches
use the whole current workspace. MCP effects name both destination server and tool. Subagent tools
mark session/background mutation. Shell effects explicitly report unrestricted current-user
filesystem, network, process, and inherited-environment access. These effects are diagnostic
metadata, not an enforcement boundary.

## Owned Shell Processes

The Rust worker owns live shell processes behind `WorkerShellRpc`. `shell.execute` remains the
one-shot compatibility method, but it now starts and waits through the same process manager used by
interactive sessions. Its returned stdout/stderr is bounded by the manager's retained transcript.
The manager is held by `NativeAgentRuntimeServices`, so separate per-tool Worker RPC router instances
share the same live process store.

The worker tool registry also receives the current config snapshot. An explicit
`tools.exec.enable: false` marks `shell.execute` and `exec_command` unavailable and rejects direct
starts. `tools.exec.timeout` supplies the default one-shot timeout. Process-management tools remain
available so a previously started process can be polled or terminated safely.

Model-visible deferred tools map to the richer RPC surface:

| Tool | Worker RPC target | Cancellation policy |
| --- | --- | --- |
| `exec_command` | `shell.start` | `terminate_process` |
| `write_stdin` | `shell.write_stdin` | `detach_forbidden` |

The tool executor overwrites tool-supplied identity fields with the active `sessionId`, `turnId`,
and `toolCallId` when these tools dispatch. `shell.start` uses `turnId` as the retained process
`ownerId`. An owned process cannot be polled, written, resized, interrupted, or terminated without
that matching `ownerId`.

### Shell RPC methods

| Method | Purpose |
| --- | --- |
| `shell.start` | Start a pipe or PTY process and wait for a bounded initial yield. |
| `shell.poll` | Return output after a sequence cursor, waiting up to `yieldTimeMs`. |
| `shell.write_stdin` | Write `input` (or alias `chars`) and return newly available output. |
| `shell.resize` | Resize an active PTY in rows and columns. |
| `shell.interrupt` | Send SIGINT on Unix or Ctrl-C to a Windows PTY. |
| `shell.terminate` | Terminate one owned process tree and verify its exit. |
| `shell.terminate_owner` | Terminate all live processes owned by one owner. |
| `shell.list` | List retained process snapshots, optionally filtered by `ownerId`. |
| `shell.shutdown` | Terminate live processes, join terminal lifecycle threads, and release records. |

`shell.start` accepts:

```json
{
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "yieldTimeMs": 1000,
  "rows": 24,
  "cols": 80,
  "turnId": "turn-1",
  "toolCallId": "call-1"
}
```

`turnId` and `toolCallId` are required for retained processes. The resulting process snapshot exposes
that Turn identity as `ownerId`. The one-shot `shell.execute` adapter uses an internal transient
owner and releases its record before returning.

There is no shell sandbox or shell-specific network isolation. Commands inherit the Tinybot
process's current-user permissions and environment. `workingDir` accepts an existing absolute
directory, including one outside the workspace, or a path relative to the workspace root.

Windows pipe processes receive a dedicated kill-on-close Job Object immediately
after creation. Failure to create or assign that job fails the start and terminates the direct child.
`shell.terminate`, turn cancellation, and Native Runtime shutdown terminate the job and verify the root
record reaches terminal state, preventing descendants from retaining inherited pipe handles or
surviving the owner.

Process snapshots use camel-case fields and include:

```json
{
  "processId": "process-1",
  "systemProcessId": 1234,
  "ownerId": "turn-1",
  "toolCallId": "call-1",
  "command": "python -i",
  "workingDir": ".",
  "tty": true,
  "status": "running",
  "running": true,
  "exitCode": null,
  "stdout": "",
  "stderr": "",
  "output": "",
  "chunks": [],
  "cursor": 0,
  "truncated": false,
  "droppedBytes": 0,
  "startedAtMs": 0,
  "lastActivityMs": 0,
  "failure": null
}
```

Pipe processes preserve stdout/stderr chunk identity. PTY output uses the `terminal` stream and is
projected into stdout for compatibility. The retained transcript keeps a 256 KiB head and 768 KiB
tail; `truncated` and `droppedBytes` make any omission explicit. Unknown process IDs and writes after
exit are errors, not empty successful polls. On Windows, the manager normalizes terminal input,
answers ConPTY cursor-position probes internally, and removes verbatim path prefixes only at the PTY
spawn boundary. Windows pipe processes are assigned to a kill-on-close Job Object so cancellation
and shutdown terminate descendant processes as well as the root process.

## Background, Task, Subagent, and Host Commands

| Group | Commands |
| --- | --- |
| Background trace | `worker_background_trace_list`, `worker_background_trace_get_delegate_trace`, `worker_background_trace_get_artifact`, `worker_background_trace_append` |
| Background subagent input | `worker_background_subagent_enqueue_input` |
| Subagent manager | `worker_subagent_spawn`, `worker_subagent_list`, `worker_subagent_query`, `worker_subagent_send_input`, `worker_subagent_wait`, `worker_subagent_cancel`, `worker_subagent_close`, `worker_subagent_resume` |
| Task plans | `worker_task_plan_list`, `worker_task_plan_get`, `worker_task_plan_save`, `worker_task_plan_delete` |
| TinyOS host operations | `worker_dispatch_tinyos_host_command` |
| WebUI proxy | `worker_webui_route` |

### Subagent lifecycle

The desktop commands and deferred Agent tools share the same manager and canonical thread store.
The deferred lifecycle tools are `subagent.spawn`, `subagent.send_input`, `subagent.wait`,
`subagent.close`, and `subagent.resume`; they become model-visible only after selection or
`tool_search`. `subagent.list`, `subagent.query`, and `subagent.cancel` remain Worker RPC and
desktop-control operations.

The default limits are eight active children per session, 32 active children process-wide, and a
maximum delegation depth of four. Nested spawns must name their direct `parentSubagentId` and exact
`delegationDepth`; the persisted child thread is attached to that direct parent's thread. Capacity
and depth failures are explicit control errors and do not create partial durable edges.

`historyMode` controls the public conversation copied into a child thread:

- `isolated` copies no parent messages;
- `parent_turn` copies user and completed assistant messages from the latest user turn;
- `full_history` copies all user and completed assistant messages.

Reasoning, tool calls and outputs, and private trace items are never inherited. Copied
messages contain source-thread and source-item provenance and use deterministic child item IDs.

After a process restart, canonically persisted active children are restored as `interrupted`.
`subagent.resume` selectively returns one interrupted child to `running`; explicitly closed or
otherwise terminal children cannot be reopened. `close` is a lifecycle retention decision, while
`cancel` records task cancellation; completed, failed, cancelled, and interrupted children remain
queryable until explicitly closed. `subagent.wait` blocks until a selected child reaches a waiting
or terminal boundary, the timeout expires, or the parent request is cancelled. The timeout defaults
to 30 seconds and is capped at 30 seconds. Waiting does not write polling snapshots into thread
history.

Host command input example:

```ts
await invoke("worker_dispatch_tinyos_host_command", {
  input: {
    clientId: "client-1",
    frame: { type: "command", command_kind: "file.save", path: "notes.txt", content: "hello" },
    attachedChatId: "thread-1",
    turnId: "turn-1",
  }
});
```

This dispatcher accepts TinyOS host operations. Chat turns, interruption, and forms use the typed
Thread commands.

## WebUI Route Wrapper

Call:

```ts
const response = await invoke("worker_webui_route", {
  input: {
    method: "GET",
    path: "/api/tools",
    headers: {},
    body: null
  }
});
```

Response:

```json
{
  "status": 200,
  "body": {},
  "headers": {
    "x-tinybot-route-owner": "rust",
    "x-tinybot-route-group": "tools"
  }
}
```

The frontend helper `createDesktopNativeWebuiApi().route()` unwraps 2xx responses and throws for non-2xx responses.
Use `routeResponse()` if the status and headers are needed.

### Rust-owned WebUI Routes

| Method | Path | Group | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/tools` | tools | Effective built-in and MCP capability catalog |
| `GET` | `/api/providers` | providers | Provider catalog |
| `POST` | `/api/provider-models` | providers | Provider model resolution |
| `POST` | `/api/agent-ui/forms/{form_id}/submit` | agent-ui | Form continuation |
| `POST` | `/api/agent-ui/forms/{form_id}/cancel` | agent-ui | Form cancellation |
| `GET` | `/api/skills` | skills | List skills |
| `POST` | `/api/skills` | skills | Create skill |
| `GET` | `/api/skills/{name}` | skills | Skill detail |
| `PATCH` | `/api/skills/{name}` | skills | Update skill |
| `DELETE` | `/api/skills/{name}` | skills | Delete skill |
| `POST` | `/api/skills/{name}/validate` | skills | Validate skill |
| `GET` | `/api/workspace/files` | workspace | List workspace files |
| `GET` | `/api/workspace/directory` | workspace | Revision-bound directory page; optional query `path` (defaults to `.`), `cursor`, and `nameQuery` |
| `GET` | `/api/workspace/read` | workspace | Revision-bound file chunk; optional query `path` (defaults to `.`) and `cursor` |
| `GET` | `/api/workspace/files/{path:.+}` | workspace | Read workspace file |
| `PUT` | `/api/workspace/files/{path:.+}` | workspace | Write workspace file |

Unknown routes return status `404`.

## Worker RPC Protocol

The lower-level worker RPC router uses this request shape:

```json
{
  "protocol_version": "1",
  "id": "req-1",
  "trace_id": "trace-1",
  "method": "workspace.read_file",
  "params": {
    "path": "README.md"
  }
}
```

It is primarily used internally by Rust command handlers through `call_rust_state_service`.
External callers should usually prefer the Tauri commands above.

### Supported Worker RPC Methods

| Namespace | Methods |
| --- | --- |
| `background.run` | `complete`, `list`, `upsert` |
| `background.subagent` | `enqueue_input` |
| `background.trace` | `append`, `get_artifact`, `get_delegate_trace`, `list` |
| `channel.connector` | `login`, `send_delta`, `send_text`, `send_usage`, `start`, `stop`, `transcribe_audio` |
| `config` | `apply_operations`, `apply_patch_result`, `get`, `snapshot_public` |
| `cron.job` | `add`, `due`, `list`, `record_runs`, `remove` |
| `diagnostics` | `append` |
| `form` | `request` |
| `mcp` | `call_tool`, `capability_catalog`, `diagnostics`, `list_tools`, `server_status`, `shutdown` |
| `permission_profile` | `current`, `evaluate_tool` |
| `provider` | `resolve_secret` |
| `runtime` | `metrics`, `now`, `restart` |
| `shell` | `execute`, `start`, `poll`, `write_stdin`, `resize`, `interrupt`, `terminate`, `terminate_owner`, `list`, `shutdown` |
| `skills` | `list`, `webui_create`, `webui_delete`, `webui_detail`, `webui_list`, `webui_update`, `webui_validate` |
| `subagent` | `cancel`, `close`, `list`, `query`, `resume`, `send_input`, `spawn`, `wait` |
| `task.plan` | `delete`, `get`, `list`, `save` |
| `task.store` | `load` |
| `thread` | `activity`, `agent_registry`, `append_items`, `append_messages`, `append_turn_context`, `apply_op`, `archive`, `clear`, `clear_latest_checkpoint`, `commit_context_checkpoint`, `context`, `continue_turn`, `create`, `delete`, `events`, `fork`, `history`, `interrupt`, `latest_checkpoint`, `list`, `persistence.check`, `persistence.repair`, `read`, `resolve`, `restore_checkpoint`, `resume`, `rollback`, `search`, `start_turn`, `status`, `task_progress.upsert`, `unarchive`, `update_metadata` |
| `thread.turn` | `append_semantic_batch`, `clear_checkpoint`, `get`, `get_checkpoint`, `list`, `mark_cancelled`, `mark_completed`, `mark_failed`, `mark_interrupted`, `runtime_state`, `set_checkpoint`, `start` |
| `tool_executor` | `execute` |
| `tool_registry` | `list`, `search` |
| `tools` | `webui_catalog` |
| `workspace` | `apply_patch`, `create_dir`, `delete_file`, `list_dir`, `list_dir_page`, `list_files`, `read_bootstrap_files`, `read_file`, `read_file_chunk`, `resolve_path`, `write_file` |

`thread.turn.start` atomically appends the minimal turn seed, turn context, changed materialized
instructions, and current user message. `thread.turn.append_semantic_batch` accepts only stable events
that can be materialized as typed message, reasoning, tool, usage, or terminal records;
delta, phase, status, provider-start, and generic trace envelopes are rejected or kept live-only.
Agent-turn reads are derived from the thread JSONL and never fall back to the in-memory thread store.

### MCP Runtime RPC

The Native Runtime owns one long-lived MCP runtime shared by Worker RPC adapters and native agent turns.
Short-lived adapters do not own child processes or HTTP sessions. A configuration update with the
`mcpConfigChanged` side effect reconciles changed, disabled, and removed servers; Native Runtime shutdown
closes HTTP sessions and terminates stdio children before stopping the worker.

Accepted transport values:

- `stdio`: starts the configured command directly without a shell;
- `http`, `streamable_http`, and `streamable-http`: use MCP Streamable HTTP;
- `sse`: rejected; there is no fallback.

Configured server maps are normalized from `tools.mcp_servers`, `tools.mcpServers`, or
`mcp.servers`. All MCP status, discovery, reconciliation, Worker RPC, and native-agent dispatch
paths use the same normalized map.

`mcp.capability_catalog` and `GET /api/tools` expose one effective snapshot containing configured
servers, runtime status, discovered tools, allowlist state, callable state, denial reasons, and input
schemas. One failed or disabled server remains visible without hiding tools from healthy servers.

Stdio configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "local-search": {
        "enabled": true,
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": { "LOG_LEVEL": "info" },
        "envVarRefs": { "SEARCH_API_TOKEN": "TINYBOT_SEARCH_API_TOKEN" }
      }
    }
  }
}
```

`env` may contain non-sensitive process settings. Keys ending in token, secret, password,
authorization, credentials, or API key are rejected when supplied inline. `envVarRefs` maps child
environment names to host environment-variable names and resolves them only at server startup.
Missing, empty, or non-Unicode referenced values fail explicitly without echoing the value.
Snake-case `env_var_refs` is also accepted.

Streamable HTTP configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "docs": {
        "enabled": true,
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnvVar": "DOCS_MCP_TOKEN",
        "httpHeaders": { "X-Tenant": "tinybot" },
        "envHttpHeaders": { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
        "startupTimeoutSeconds": 10,
        "timeoutSeconds": 30,
        "enabledTools": ["search"]
      }
    }
  }
}
```

`bearerTokenEnvVar` and `envHttpHeaders` contain environment-variable names, not secret values.
Missing, empty, or non-Unicode values fail startup explicitly. Inline `bearerToken` / `bearer_token`
is rejected; use the environment-backed field. URL credentials and fragments are also rejected.
Snake-case aliases are accepted for these fields.

`mcp.list_tools` takes no params and returns enabled servers, normalized real tool schemas, and live
status:

```json
{
  "servers": [
    {
      "name": "docs",
      "status": {
        "state": "ready",
        "transport": "http",
        "toolCount": 4,
        "elapsedMs": 18,
        "lastError": null
      },
      "tools": [{ "name": "search", "inputSchema": { "type": "object" } }]
    }
  ]
}
```

`mcp.call_tool` params and response:

```json
{
  "server": "docs",
  "tool": "search",
  "arguments": { "query": "runtime ownership" }
}
```

```json
{
  "server": "docs",
  "tool": "search",
  "content": [],
  "structuredContent": {},
  "isError": false,
  "result": {}
}
```

The server and tool must be enabled and allowlisted. Discovery and calls support startup/call
timeouts and request cancellation. Cancellation before or during client startup, initialization,
or `tools/list` closes the partial transport, marks the server failed with a cancelled diagnostic,
and stops discovery promptly. Cancellation during an active call uses the same cleanup path. The
next discovery or call starts a clean client.

Additional methods:

- `mcp.server_status` params: `{ "serverId": "docs" }`;
- `mcp.diagnostics`: returns a bounded transition list containing `serverId`, `transport`, `state`,
  `phase`, `elapsedMs`, `errorCode`, and a sanitized `message`;
- `mcp.shutdown`: closes every managed server and returns `{ "stopped": true }`.

## Tauri Event Names

The Rust backend emits live native-agent events through Tauri. Source names containing dots are
normalized to colon-separated Tauri listener names; for example, `agent.delta` is emitted as
`agent:delta`. The current source-name catalog is:

| Category | Source event names |
| --- | --- |
| Turn and control | `agent.turn.started`, `agent.phase.changed`, `agent.status`, `agent.guidance`, `agent.paused`, `agent.resumed`, `agent.command.acknowledged` |
| Context and hooks | `agent.context.hydrated`, `agent.context.compacted`, `agent.context.trimmed`, `agent.context.compaction_failed`, `agent.hook.decision`, `agent.checkpoint` |
| Model output | `agent.reasoning_delta`, `agent.reasoning.completed`, `agent.delta`, `agent.message.phase`, `agent.message.classified`, `agent.message.completed`, `agent.model_call.completed`, `agent.token_count`, `agent.usage` |
| Tools and product items | `agent.tool_call.delta`, `agent.tool.start`, `agent.tool.result`, `agent.tool.debug`, `agent.tool.cleanup_timeout`, `agent.plan.progress`, `agent.task_progress`, `agent.awaiting_form`, `agent.form.resolution`, `agent.file.reference` |
| Terminal | `agent.done`, `agent.error`, `agent.cancelled`, `agent.cleanup_timeout` |
| Delegates | `agent.delegate.linked`, `agent.delegate.started`, `agent.delegate.running`, `agent.delegate.wait`, `agent.delegate.result`, `agent.delegate.notification`, `agent.delegate.queried`, `agent.delegate.user_message`, `agent.delegate.message_queued`, `agent.delegate.spawned`, `agent.delegate.message`, `agent.delegate.completed`, `agent.delegate.cancelled`, `agent.delegate.closed`, `agent.delegate.failed`, `agent.delegate.interrupted`, `agent.delegate.resumed`, `agent.delegate.spawn_rejected`, `agent.delegate.trace.updated` |
| Timeline projection | `agent.timeline.patch` |

The desktop shell also emits:

| Tauri event | Payload |
| --- | --- |
| `desktop-menu-command` | Native application-menu command |
| `desktop-update-status` | `DesktopUpdateSnapshot` after each update phase or download-progress change |
| `tinyos:host-operation` | Asynchronous TinyOS host-operation status |
| `tinyos:browser-snapshot` | `BrowserNativeSnapshot` |
| `tinyos:browser-diagnostic` | `BrowserRuntimeDiagnostic` |

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
context-window budget fields:

- `context_window_tokens` / `contextWindowTokens`: effective context window from
  `agents.defaults.contextWindowTokens` or the backend default.
- `context_window_used_tokens` / `contextWindowUsedTokens`: provider `prompt_tokens` when present,
  then provider `total_tokens`, otherwise the local request estimate.
- `context_window_remaining_tokens` / `contextWindowRemainingTokens`: remaining context budget.
- `estimated_context_tokens` / `estimatedContextTokens`: local approximate token count for the
  request sent after context-window trimming.
- `context_window_strategy` / `contextWindowStrategy`: effective strategy, currently `discard` or
  `compact`.
- `percent`: context-window usage percentage.

Rust agent context-window controls are read from `agents.defaults` or the turn specification:

- `contextWindowTokens` / `context_window_tokens`: effective context window. When unset,
  `deepseek-v4-flash` and `deepseek-v4-pro` use `1000000`; other models fall back to `128000`.
- `contextWindowStrategy` / `context_window_strategy`: `discard` or `compact`. The fallback is
  `discard`.
- `compactTriggerPercent` / `compact_trigger_percent`: percentage threshold for `compact`; default
  `90`.
- `compactSummaryMaxTokens` / `compact_summary_max_tokens`: max completion tokens for the internal
  summary request; default `1024`.

`discard` keeps the newest messages that fit the window. `compact` sends older messages through an
internal non-streaming `chat/completions` request, inserts the returned summary as a system message,
and keeps recent messages. The summary request uses the same async timeout, cancellation, and typed
failure path as the main provider request; failure is explicit and does not silently fall back to
`discard`.

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

## Recommended Frontend Wrappers

Prefer these wrappers instead of direct command strings:

| Wrapper | File | Commands/routes covered |
| --- | --- | --- |
| `createDesktopNativeConfigApi` | `src/app-core/native/desktopNativeConfig.ts` | Config snapshot |
| `createDesktopNativeUpdateClient` | `src/app-core/native/desktopNativeUpdate.ts` | Desktop update status, check, install, and status events |
| `createDesktopNativeThreadsApi` | `src/app-core/native/desktopNativeThreads.ts` | Thread, Turn timeline, and effective-capability commands |
| `createDesktopNativeHostCommandApi` | `src/app-core/native/desktopNativeHostCommand.ts` | Remaining non-chat TinyOS host commands |
| `createDesktopNativeWebuiApi` | `src/app-core/native/desktopNativeWebui.ts` | `worker_webui_route` |

## Examples

List Thread turns:

```ts
await invoke("thread_list_turns", {
  input: { body: { threadId: "thread-1" } }
});
```

Read canonical Turn runtime state:

```ts
await invoke("thread_get_turn_runtime_state", {
  input: { body: { threadId: "thread-1", turnId: "turn-1" } }
});
```

Create and read a thread:

```ts
const created = await invoke("worker_thread_create", {
  input: { body: { title: "Investigation" } }
});

const snapshot = await invoke("worker_thread_read", {
  input: { body: { threadId: created.thread.threadId, limit: 100 } }
});
```

Call an HTTP-compatible route through Rust:

```ts
const response = await invoke("worker_webui_route", {
  input: {
    method: "GET",
    path: "/api/workspace/files"
  }
});

if (response.status === 200) {
  console.log(response.body);
}
```

Apply a config operation:

```ts
await invoke("apply_config_operations", {
  request: {
    expectedRevision: currentRevision,
    operations: [
      { op: "replace", path: "agents.defaults.model", value: "deepseek-v4-pro" }
    ]
  }
});
```

Read the settings control-center projection:

```ts
const snapshot = await invoke("get_settings_snapshot");
```

## Native Browser session runtime

The backend-owned WebView2 runtime is part of the default Windows desktop build. A deliberately
minimal build compiled with `--no-default-features` returns unavailable decisions with reason code
`feature_disabled`. The remote child webviews are not members of the Tauri capability set,
`withGlobalTauri` is disabled, and page content receives no TinyBot IPC or privileged host object.
Non-Windows builds return unavailable decisions with reason code `platform_unsupported` rather than
synthetic browser state.

The public commands are:

| Command | Input | Result |
| --- | --- | --- |
| `browser_capabilities` | none | `tinybot.browser_runtime_capabilities.v1` |
| `browser_metrics` | none | bounded counters and last-duration metrics |
| `browser_create_session` | owner session, optional profile/persistence/initial URL | authoritative `browser_session_v1` snapshot; idempotent by owner session |
| `browser_snapshot` | browser session identity | current authoritative snapshot |
| `browser_close_session` | browser session identity | cleanup completion or an incomplete-cleanup error |
| `browser_create_tab` | browser session and optional URL | updated snapshot |
| `browser_activate_tab`, `browser_close_tab`, `browser_restart_tab` | browser session and tab | updated snapshot |
| `browser_navigate` | browser session, tab, URL | updated snapshot after dispatch |
| `browser_back`, `browser_forward`, `browser_reload`, `browser_stop` | browser session and tab | completion or exact platform error |
| `browser_update_surface` | surface identity, layout revision, CSS-pixel rectangle, scale and visibility gates | updated snapshot |
| `browser_observe` | browser session, tab, capture/semantic flags | snapshot plus optional real capture and semantic observation |
| `browser_interact` | session, tab, command, control epoch, observation/capture identities and typed action | terminal command result |
| `browser_resolve_policy_request` | browser session, pending request identity, allow/deny decision | updated snapshot after the confirmed popup or external-protocol operation finishes |
| `browser_delete_profile` | profile identity | cleanup completion or an exact deletion error; active profiles are rejected |

Session ownership, control epochs, observations, protected handoff, profile cleanup, privacy limits,
and native integration verification are documented in `src-tauri/src/native_browser/README.md`.

