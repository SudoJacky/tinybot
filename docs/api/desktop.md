# Desktop Commands

This document covers native desktop lifecycle and operating-system integration
commands. It is part of the [Rust backend API reference](rust-backend-api.md),
which records the code snapshot and shared invocation conventions for this
reference set.

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

## Sidecar Terminal Commands

| Command | Args | Response |
| --- | --- | --- |
| `terminal_create` | `{ input: { terminalId, shell: "powershell" \| "cmd", workingDirectory?, rows, cols } }` | `DesktopTerminalSnapshot` |
| `terminal_poll` | `{ input: { terminalId, cursor, yieldTimeMs? } }` | `DesktopTerminalSnapshot` |
| `terminal_write` | `{ input: { terminalId, cursor, input } }` | `DesktopTerminalSnapshot` |
| `terminal_resize` | `{ input: { terminalId, rows, cols } }` | `void` |
| `terminal_terminate` | `{ input: { terminalId } }` | `void` |

`terminal_create` is idempotent for one Sidecar resource ID and rejects a
second configuration for that ID. Snapshots contain ordered output after the
requested cursor, the next cursor, process status, exit code, truncation
metadata, and an optional failure. These commands use a dedicated process
manager that is not shared with Agent shell tools. Switching or hiding a
Sidecar tab does not invoke termination; closing the resource terminates and
releases its PTY record. When `workingDirectory` is omitted, the command uses
the same configured native backend workspace as an ordinary Thread, falling
back to `~/.tinybot/workspace`.

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

Turn instruction fields may appear at the turn specification root or under
`metadata`; snake_case aliases are also accepted. `selectedSkills` is an
ordered array of qualified Agent Plugin skill names such as
`create-agent-plugin:migrate-agent-plugin`. The composer injects a bounded
catalog of skills from enabled global plugins, then injects the full content
of explicitly selected skills in array order. Missing, disabled, invalid, or
duplicate selections fail before provider dispatch. Workspace profile files
have a 64 KiB per-file limit, while project instructions share a 64 KiB
aggregate budget. Invalid UTF-8, unreadable paths, invalid field types,
truncation, and empty sources are surfaced instead of silently disappearing.

## Renderer Logging Commands

| Command | Args | Response |
| --- | --- | --- |
| `record_renderer_diagnostic` | `{ input: unknown }` | `void` |
| `record_renderer_log` | `{ input: RendererLogEntry }` | `void` |

`RendererLogEntry` uses schema `tinybot.renderer_log.v1` and contains `at`, a
`debug | info | warn | error` level, a non-empty `stage`, and an object-valued
`details` field. Unknown schemas, levels, fields, or invalid shapes fail fast.

Both commands route through the shared `tinybot.native_log.v1` collector, add
the record to the process-local runtime ring, and append it to the persistent
native backend log. Context strings, arrays, objects, and nesting are bounded;
credential, token, prompt, and request or response body keys are redacted.
Serialized records above 64 KiB and log write failures reject the command.

## Desktop Performance Trace and Diagnostic Bundle Commands

| Command | Args | Response |
| --- | --- | --- |
| `desktop_performance_snapshot` | none | `PerformanceTraceSnapshot` |
| `desktop_export_diagnostic_bundle` | `{ input: DiagnosticBundleInput }` | `DiagnosticBundleExportResult \| null` |

`PerformanceTraceSnapshot` uses schema `tinybot.performance_trace.v1`. It
combines the existing process-local runtime metrics snapshot with at most 200
recent structured events collected through shared desktop state. Events carry
their timestamp, stream, level, event identifier, and already bounded/redacted
context. The snapshot is read-only, resets with the app process, and does not
start a background sampler.

`DiagnosticBundleInput` uses schema `tinybot.diagnostic_bundle_input.v1` and
contains the current diagnostic-mode flag, optional locale and time zone, and
at most 300 renderer log entries (4 MiB serialized). The command opens a native
save dialog and returns `null` when the user cancels. A successful result uses
schema `tinybot.diagnostic_bundle.v1` and returns the local path, ZIP size, and
included entry names.

The ZIP contains `manifest.json`, `performance-trace.json`,
`renderer-logs.json`, `system-info.json`, and the available bounded native log
files (`native-backend.log` and `native-backend.log.1`). Each native source is
limited to its newest 6 MiB. Persistent structured log lines and renderer
details are parsed and redacted again during export; malformed persistent lines
are omitted and counted in the manifest. System information is allowlisted to
app version, OS, architecture, locale, time zone, and diagnostic-mode state.

The bundle is saved locally and is never uploaded automatically. Its manifest
marks user review as required because paths and arbitrary error messages can
still contain private data even after key-based redaction. Users should inspect
the ZIP before manually attaching it to an Issue.

## Desktop Menu Shortcut Command

| Command | Args | Response |
| --- | --- | --- |
| `desktop_set_menu_shortcuts` | `{ bindings: Array<{ id: string, accelerator: string \| null }> }` | `void` |

The renderer sends the complete binding set for the six configurable desktop commands. The backend
rejects missing, duplicate, unknown, conflicting, or unsupported bindings before updating the
native application menu. A `null` accelerator clears that command's native shortcut. Menu clicks
and native accelerator activations are emitted through `desktop-menu-command` with `{ id: string }`.

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
Reasoning effort is not an Agent Defaults setting. A legacy `agents.defaults.reasoningEffort` value
may remain in raw config for read compatibility, but the settings registry does not expose it and the
agent runtime does not apply it to model requests.
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
