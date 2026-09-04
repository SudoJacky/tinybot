# Desktop Commands
<!-- tinybot-doc-watch:
src-tauri/src/desktop/bootstrap.rs
src-tauri/src/desktop/pet.rs
src-tauri/src/desktop/diagnostics.rs
src-tauri/src/desktop/files.rs
src-tauri/src/desktop/logging.rs
src-tauri/src/desktop/tray.rs
src-tauri/src/desktop/update.rs
src-tauri/src/desktop_terminal.rs
src-tauri/src/desktop_commands/config.rs
src-tauri/src/desktop_commands/hooks.rs
src-tauri/src/desktop_commands/plugins.rs
src-tauri/src/agent/provider/completion.rs
src/app-core/native/desktopNativeHooks.ts
src/app-core/native/desktopNativePet.ts
src/app-core/native/desktopNativePetQuickChat.ts
src/app-core/native/nativeBackendContract.test.ts
-->
<!-- tinybot-doc-fingerprint: sha256:639c0133eefceb1dab9175e0fd6ea7f829aa2f59ce50cab2a38ed6b09c112f05 -->

This document covers native desktop lifecycle and operating-system integration
commands. It is part of the [Rust backend API reference](rust-backend-api.md),
which defines the shared invocation conventions and source-backed freshness
policy for this reference set.

## Native Runtime Lifecycle

The Rust backend is an in-process Native Runtime. Tauri setup starts it before the renderer uses
typed commands. Closing `main` hides the window in the system tray and keeps the Native Runtime
active; explicit tray exit or updater installation runs its bounded shutdown path. There are no
renderer commands for managing a separate backend process, and the runtime cannot be configured to
remain alive after the App exits.

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

## Windows Desktop Pet Windows

On Windows, desktop setup creates two hidden, transparent webviews in addition
to `main`: the `desktop-pet` mascot and the `desktop-pet-chat` quick-chat
panel. Both are undecorated, always on top, omitted from the taskbar, and own
isolated hidden menus so application-menu text cannot leak into their compact
surfaces. The pet deliberately has no owner or parent window, so minimizing
the main window does not remove it from the desktop.

The pet renderer is selected with `index.html?surface=desktop-pet`; it does not
start another App service graph. Dropping external `text/plain` content on the
pet, dropping one to ten local `Files`, or clicking its chat affordance sends a
validated `tinybot.desktop_pet_quick_chat.v2` request through the typed
`desktopNativePetQuickChat` event seam. Text remains an editable draft. For
files, the HTML5 drop supplies WebView2 additional objects; `pet_file_drop`
validates the Tauri invoke key, extracts only local paths, and delegates to the
same native attachment importer as `pick_chat_files`. Images therefore receive
a managed path and content hash, ordinary files retain their path, directories
fail explicitly, and no file bytes cross the renderer message boundary. The
main renderer positions the quick-chat panel next to the pet within the current
monitor work area, then the `?surface=desktop-pet-chat` renderer presents the
editable draft and removable attachments and uses the canonical Thread stores
for model selection, token usage, timeline updates, and first-send creation of
a standard non-workspace Thread. File-only submission is valid. Its title bar
starts native window dragging while leaving the window controls interactive.
Opening a quick-chat Thread in Tinybot first shows, restores, and focuses
`main`, then refreshes and activates the explicit Thread ID carried by the
event.

The main renderer remains authoritative for the pet label, mood, visibility,
size, and persisted physical-desktop center. The typed
`desktopNativePet` host/client seam synchronizes that snapshot through scoped
Tauri events, uses the native `startDragging` operation for pointer movement,
and reports settled native window moves back to `main`. Monitor work areas are
used when restoring or resizing the pet, including monitors with negative
coordinates.

Closing `desktop-pet` prevents destruction, hides the window, and notifies
`main` to persist `visible: false`; closing `desktop-pet-chat` hides it without
discarding canonical Thread state. Closing `main` prevents destruction and
hides only the main window, leaving the browser, Sidecar terminal, Agent
runtime, and pet available. A left click on the Tinybot tray icon or the
“显示 Tinybot” tray command shows, restores, and focuses `main`. The
“退出 Tinybot” command is guarded against duplicate requests, records each
cleanup boundary, shuts down the browser, terminal, and Agent runtime, and
then requests process exit. The pet's
Windows-only capability grants only event, position, scale-factor, native-drag,
and the no-op `desktop_pet_drop_signal` used to authenticate the WebView2
additional-object message. The command does not accept paths or file bytes and
is not a general-purpose `invoke` API. The quick-chat capability grants events,
window hide, native dragging, `pick_chat_files`, and the remaining
least-privilege application-command subset for its chat workflow. The
build-time application-command manifest prevents either
auxiliary webview from inheriting the wider main-window command surface.

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

## Sidecar Artifact File Preview

Assistant Markdown file links open contextual Artifact tabs; Artifact is not an
empty resource offered by the Sidecar add menu. The renderer recognizes
workspace-relative paths, `file:` URLs, absolute paths inside the active
workspace, and optional line suffixes. It sends the Thread ID and normalized
path to the thread-scoped workspace commands, never a renderer-selected
workspace root.

The backend resolves the canonical Thread projection and uses its recorded
`workingDirectory`, falling back to the configured default workspace only when
the Thread is unbound. It then delegates to the guarded workspace readers, so
traversal and symlink escapes fail explicitly. Text previews use
`worker_thread_workspace_file_chunk`. Modern `.xlsx`, `.docx`, and `.pptx`
previews first read binary metadata, then request at most 25 MiB from
`worker_thread_workspace_file_bytes` with the expected source revision. The
Artifact surface shows loading, truncation, unsupported-binary, source-change,
and read-failure states instead of an empty successful preview.

## File Dialog Commands

| Command | Args | Response |
| --- | --- | --- |
| `pick_upload_file` | `{ options: { title?: string, filters?: { name: string, extensions: string[] }[] } }` | `null` when cancelled, or `{ name, path, mime_type, size_bytes, bytes }` |
| `pick_chat_files` | `{ options: { title?: string, filters?: { name: string, extensions: string[] }[] } }` | `[]` when cancelled, or `{ name, path, mimeType, sizeBytes, contentHash? }[]`; non-files fail, supported images are copied into Tinybot-managed storage and identified by `contentHash`, while other files keep their selected path; file bytes are not returned |
| `pick_workspace_directory` | `{ options: { title?: string } }` | `null` when cancelled, or the selected absolute UTF-8 path |
| `save_export_file` | `{ options: { title?: string, defaultPath?: string, filters?: Filter[], contents: string } }` | `null` when cancelled, or `{ path }` |
| `reveal_workspace_file` | `{ path: string }` | `void` |

The Tauri asset protocol is enabled only for
`$HOME/.tinybot/chat-attachments/images/**`. Chat image previews convert the
managed path to an asset URL; arbitrary selected files and other local paths
remain outside the renderer-readable scope.

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
7. project-local `.agents/skills` and `.codex/skills` catalog (`640`), enabled Agent Plugin skill catalog (`650`), and explicitly selected skill files (`700 + index`);
8. `collaborationMode` and `agentRole` instructions (`800`, `810`);
9. generated working-directory and operating-system facts (`900`).

The long-term-memory source is historical context, not an instruction authority. Its wrapper
explicitly states that the current request wins when it conflicts with stored memory. The exact
snapshot is fixed when the Thread is created, so later global memory changes do not invalidate the
stable prompt prefix of an existing Thread.

Turn instruction fields may appear at the turn specification root or under
`metadata`; snake_case aliases are also accepted. `selectedSkills` is an
ordered array containing either unqualified project-local skill names such as
`review-work` or qualified Agent Plugin skill names such as
`create-agent-plugin:migrate-agent-plugin`. The composer injects catalogs from
the effective working directory's `.agents/skills` and `.codex/skills`
hierarchies and enabled global plugins, then injects the full content of explicitly selected skills in array
order. Missing, disabled, invalid, or duplicate selections fail before provider dispatch. Workspace profile files
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
| `desktop_memory_snapshot` | none | `DesktopMemorySnapshot` |
| `desktop_export_diagnostic_bundle` | `{ input: DiagnosticBundleInput }` | `DiagnosticBundleExportResult \| null` |

`PerformanceTraceSnapshot` uses schema `tinybot.performance_trace.v1`. It
combines the existing process-local runtime metrics snapshot with at most 200
recent structured events collected through shared desktop state and one memory
snapshot. Events carry
their timestamp, stream, level, event identifier, and already bounded/redacted
context. The snapshot is read-only, resets with the app process, and does not
start a background sampler.

Startup duration metrics cover desktop setup, native runtime startup, auxiliary
window creation, and orphaned-Turn recovery. The renderer adapter merges its
bounded startup phases for React commit, first frame, event registration, and
session restoration into the returned snapshot. Loading or exporting this
diagnostic state does not wait for Chat initialization.

`DesktopMemorySnapshot` uses schema `tinybot.memory_snapshot.v1`. On Windows it
reports private bytes, current working set, and peak working set for the Rust
host and for each WebView2 browser, renderer, GPU, and utility process shared by
the application's webviews. Shared WebView2 PIDs are counted once and retain
the labels of every webview that reported them. A partial result includes
structured collection errors; unsupported platforms return `unsupported`
without inventing process values.

`DiagnosticBundleInput` uses schema `tinybot.diagnostic_bundle_input.v1` and
contains the current diagnostic-mode flag, optional locale and time zone, and
at most 300 renderer log entries (4 MiB serialized) plus at most 300 memory
samples (4 MiB serialized). The command opens a native save dialog and returns
`null` when the user cancels. A successful result uses
schema `tinybot.diagnostic_bundle.v1` and returns the local path, ZIP size, and
included entry names.

The ZIP contains `manifest.json`, `performance-trace.json`,
`renderer-logs.json`, `system-info.json`, optional `memory-samples.json`, and
the available bounded native log files (`native-backend.log` and
`native-backend.log.1`). Each native source is
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

## Command Hook Commands

| Command | Args | Response |
| --- | --- | --- |
| `worker_hooks_snapshot` | `{ input: { workspacePath?: string } }` | `CommandHookCatalogSnapshot` |
| `worker_hook_set_trusted` | `{ input: { workspacePath?: string, hash: string, trusted: boolean } }` | `CommandHookCatalogSnapshot` |
| `worker_managed_hook_save` | `{ input: { workspacePath: string, id?: string, name: string, event: string, matcher?: string, language: "powershell" | "shell", enabled: boolean, timeout: number } }` | `CommandHookCatalogSnapshot` |
| `worker_managed_hook_test` | `{ input: { workspacePath: string, id: string } }` | `ManagedHookTestResult` |
| `worker_managed_hook_archive` | `{ input: { workspacePath: string, id: string } }` | `CommandHookCatalogSnapshot` |
| `worker_managed_hook_script_read` | `{ input: { workspacePath: string, id: string } }` | `ManagedHookScript` |
| `worker_managed_hook_script_save` | `{ input: { workspacePath: string, id: string, contents: string, expectedRevision: string } }` | `ManagedHookScript` |

Tinybot loads additive command-hook definitions from `~/.tinybot/hooks.json`
and `<workspace>/.tinybot/hooks.json`. The first supported events are
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `PostCompact`. Matchers are
regular expressions over tool names for tool events and `manual` or `auto` for
`PostCompact`; an omitted matcher or `"*"` matches every invocation.

Opening Settings > Hooks also creates non-destructive starter material under
the global Tinybot data directory when it is missing:

- `hooks.example.jsonc` contains separately commented definitions for all four
  events. It is documentation only and is never loaded as configuration.
- `hook-templates/hook-template.ps1` and `hook-template.sh` consume the JSON
  stdin contract, default to a no-op `{}` response, and include commented
  event-specific output examples.

Existing template files are never overwritten. The snapshot returns
`templateConfigPath` and `templateScriptsPath`, which Settings > Hooks displays
next to the active configuration paths. Copy a script into the workspace and
copy/uncomment only the required event properties into an active `hooks.json`.

Settings > Hooks obtains its workspace choices from the shared persisted
workspace registry. Missing folders remain visible but disabled. The managed-hook
form owns configuration below `<workspace>/.tinybot/hooks/<id>/hook.json` and
creates `hook.ps1` or `hook.sh` beside it. Users edit the script while Tinybot
maintains the event, matcher, interpreter command, timeout, and enabled state.
Saving an existing managed hook never overwrites an existing script. Managed
definitions and hand-written global/workspace `hooks.json` definitions are
additive and appear in the same catalog. A managed summary sets `enabled` and
adds `managed` metadata containing `id`, `name`, `language`, `manifestPath`, and
`scriptPath`.

The managed test command requires the selected hook to be enabled and trusted,
runs only that hook with a bounded event-specific sample, and returns its
decision, duration, structured feedback, and failure summary without exposing
raw process output. Removing a managed hook is recoverable: Tinybot moves its
directory to `<workspace>/.tinybot/hooks-archive/<id>-<timestamp>` and returns
the refreshed catalog.

Settings can also edit a selected managed script inline. The native boundary
accepts only a workspace and managed-hook ID, derives the script path from the
validated manifest, rejects scripts outside the workspace or above 256 KiB,
and saves atomically. `expectedRevision` is the SHA-256 revision returned by the
read command; a stale revision fails instead of overwriting an external edit.

```json
{
  "description": "Workspace policy hooks",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "^(workspace\\.|shell_command$)",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/review-tool.sh",
            "commandWindows": "powershell -File scripts/review-tool.ps1",
            "timeout": 30,
            "statusMessage": "Reviewing tool input"
          }
        ]
      }
    ]
  }
}
```

Only synchronous `type: "command"` handlers are currently supported. `async:
true`, prompt handlers, agent handlers, and unsupported events are skipped with
catalog diagnostics. Commands run in the active working directory, receive one
JSON object on stdin, and must write either event-specific JSON or no output to
stdout. `UserPromptSubmit` additionally accepts plain stdout as developer
context. The runner bounds input and output, defaults to a 600-second timeout,
accepts at most 600 seconds, and terminates the process tree on timeout.

Common input fields are `session_id`, `turn_id`, `cwd`, `hook_event_name`,
`model`, and `permission_mode`. Event inputs add `prompt`, or
`tool_name`/`tool_use_id`/`tool_input`, plus `tool_response` for `PostToolUse`,
or `trigger` for `PostCompact`.

`PreToolUse` may deny a call with `permissionDecision: "deny"`, or replace its
arguments with `permissionDecision: "allow"` plus an object-valued
`updatedInput`. `PostToolUse` may replace only the model-visible result and does
not roll back completed side effects. `PostCompact` may stop the turn after the
new compacted history has been installed. `additionalContext` is inserted as a
developer message; `systemMessage` is included in `agent.hook.decision` for the
UI and trace.

Every handler is disabled until the exact hash of its source path, event,
matcher, and complete definition is trusted. Trust is stored in
`~/.tinybot/hook-trust.json`. Editing a definition changes the hash and requires
another review. The Settings > Hooks page calls these commands to show both
configuration sources, diagnostics, definitions, and their trust status. Hook
commands inherit the desktop user's operating-system authority and are not
sandboxed by the Agent tool capability policy.

## Token Usage Command

| Command | Args | Response |
| --- | --- | --- |
| `worker_token_usage_snapshot` | none | `TokenUsageSnapshot` |

Every successful Chat Completions or Responses provider call that reports usage
uses one shared field mapper and records canonical input, cached-input, output,
reasoning-output, and total tokens in
`~/.tinybot/state/token-usage.sqlite`. The provider completion boundary covers
ordinary Agent turns, tool-loop continuations, subagents, context compaction,
memory maintenance, and Agent Graph routing. Records are atomically aggregated
by the device's local `YYYY-MM-DD` calendar day and by the resolved
Provider/model pair; an internal unique model-call identifier prevents a
completed call from being counted twice. Missing provider usage is kept distinct
from an explicit zero and does not create a zero-token record. Existing v1 daily
rows are retained during migration and exposed as `unknown` Provider and model
dimensions. Usage persistence is best effort: a storage failure increments
`provider.tokenUsage.persistence.failed` and emits a provider diagnostic, while
the already successful completion remains available to the caller.

`TokenUsageSnapshot` uses schema `tinybot.token_usage.v2` and returns `totals`,
newest-first `days`, and newest-first `modelDays`. Each `modelDays` item adds
`date`, `providerId`, and `modelId` to the same five camelCase count fields:
`inputTokens`, `cachedInputTokens`, `outputTokens`, `reasoningOutputTokens`, and
`totalTokens`. Cached input is a subset of input, and reasoning output is a
subset of output when reported by the Provider.

## Config Commands

| Command | Args | Response |
| --- | --- | --- |
| `get_settings_snapshot` | none | `SettingsSnapshot` |
| `get_config_editor_snapshot` | none | `ConfigEditorSnapshot` |
| `apply_config_patch_result` | `{ result: ConfigPatchBridgeResult }` | `ConfigPatchApplyResult` |
| `apply_config_operations` | `{ request: ConfigOperationRequest }` | `ConfigPatchApplyResult` |

Config commands use `$HOME/.tinybot/config.json`. On Rust backend startup, and before each config
command loads the store, the backend ensures the config file exists. If the file is missing it creates
a schema v2 default config with:

- `schemaVersion: 2`
- `agents.defaults.activeProfile: "deepseek-default"`
- `agents.defaults.model: "deepseek-v4-pro"`
- `providers.profiles.deepseek-default` with DeepSeek V4 models and the built-in `reasoning` capability

Existing files are never overwritten by this initialization path, including invalid JSON or non-object
config files. If default creation succeeds, config snapshots include an info diagnostic with code
`DefaultConfigCreated`. If default creation fails, snapshots still return effective in-memory defaults
and include a warning diagnostic with code `DefaultConfigCreateFailed`.

Schema v1 files are migrated at the single Rust Config-store load boundary. The migration creates a
one-time `config.json.v1.bak`, writes schema v2 atomically, and removes the retired
`agents.defaults.provider: "auto"` value when `agents.defaults.activeProfile` names a valid Provider
Profile. An Auto value without a resolvable active Profile is left unchanged and reported as
`InvalidConfig`, so the user must choose a Profile instead of having the runtime infer a Provider from
the model name.

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
`providers.profiles.<profileId>.provider`. Auto Provider routing is not supported, and the runtime does
not infer a Provider from the model name.
The Provider & Models default selector updates `agents.defaults.activeProfile` and
`agents.defaults.model` in one native patch so Profile-based endpoint resolution and global model
fallbacks cannot diverge. The same page can optionally set `memory.activeProfile` and
`memory.model` as a pair for long-term Memory extraction and consolidation; when both fields are
absent, Memory follows the global default pair.
Reasoning effort is not an Agent Defaults setting. A legacy `agents.defaults.reasoningEffort` value
may remain in raw config for read compatibility, but the settings registry does not expose it and the
agent runtime does not apply it to model requests.
The built-in provider catalog currently exposes `deepseek`, `dashscope`, `openai`, `zai`, and
`ollama`.
Profiles are not limited to that catalog: a profile with a custom provider ID, explicit `apiBase`,
and at least one model is resolved as an OpenAI-compatible provider. Its optional API key remains on
the existing secret/redaction path, and `supportsModelDiscovery` controls `/models` discovery.
The built-in `ollama` Provider targets the local OpenAI-compatible endpoint at
`http://127.0.0.1:11434/v1`. It is usable without an API key, has no curated model IDs, and exposes
downloaded models through live discovery. Chat Completions requests translate Tinybot's
`max_completion_tokens` setting to Ollama's supported `max_tokens` field. Ollama reasoning effort is
passed through for `none`, `low`, `medium`, and `high`; unsupported values fail before the request
instead of being silently downgraded.
Every built-in and custom Provider profile defaults `supportsReasoningEffort` to `true`; set it to
`false` to omit effort from both Chat Completions and Responses requests for endpoints that reject
the field.
Context windows are model-specific. A provider profile can store explicit overrides as
`modelContextWindows`, for example:

```json
{
  "modelContextWindows": [
    { "model": "local-small-model", "contextWindowTokens": 32768 }
  ]
}
```

The runtime prefers a turn override, then the active profile's model override, then Tinybot's
known-model default. `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp`, and
`deepseek-v4-pro`, plus `glm-5.3` and `glm-5.3-flash`, default to `1000000`;
unknown models use the legacy `agents.defaults.contextWindowTokens` value when present and
otherwise fall back to `128000`.
The settings UI edits these values per model instead of applying one global window to every model.
Provider profiles can also separate their discovered model catalog from the models shown in model
selectors. `models` retains the available IDs, while `enabledModels` contains only the IDs exposed
in Chat, Agent Graphs, and other shared model pickers. When `enabledModels` is absent, existing
profile `models` remain enabled for backward compatibility. Models newly returned by a refresh are
added to the catalog but remain disabled until selected in Provider & Models settings.

Image input is a model capability rather than an API-mode capability. Profiles can override it with
`modelCapabilities`:

```json
{
  "enabledModels": ["custom-vision"],
  "modelCapabilities": [
    { "model": "custom-vision", "inputModalities": ["image"] }
  ]
}
```

Missing capability entries use Tinybot's known-model defaults. `glm-5.3-flash` and
`deepseek-v4-flash-vision-exp` support image input by default; unknown models default to text-only
until enabled explicitly. The runtime enforces the resolved model capability before either Chat
Completions or Responses requests are constructed.
Each profile defaults to Chat Completions. Set `apiMode` to `responses` (or enable **Use Responses
API** in provider settings) only when its endpoint supports `/responses`.
The built-in `zai` profile is restricted to Chat Completions. It uses
`https://open.bigmodel.cn/api/paas/v4` and maps Tinybot's maximum-output setting to Z.ai's
`max_tokens` field. Z.ai profiles reject unsupported Responses mode, out-of-range temperature,
and explicitly requested parallel tool calls before a request is sent.

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
- `ollama` uses `GET http://127.0.0.1:11434/v1/models` by default and does not require an API key.
  The catalog starts empty because available model IDs come from the models installed in the local
  Ollama runtime.
- `zai` uses the static `glm-5.3`, `glm-5.3-flash`, and `glm-5.2` model list. Live `/models`
  discovery is disabled because the supported integration contract only guarantees Chat
  Completions.

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
