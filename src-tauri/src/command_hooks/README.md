# Command Hooks
<!-- tinybot-module-fingerprint: sha256:eeb46813f23bf22b26d2fc28f3513ff1423ef4d413e5408f07eea668abb860f9 -->

`command_hooks` discovers, validates, reviews, and runs user-defined lifecycle
commands. Tinybot loads `hooks.json` from the global data directory and the
active workspace's `.tinybot` directory. Sources are additive.

The first supported Codex-compatible events are `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `PostCompact`. Each command receives one JSON
object on stdin and returns event-specific JSON on stdout. Only synchronous
`type: "command"` handlers are accepted.

Catalog snapshots provision a commented `hooks.example.jsonc` plus PowerShell
and POSIX shell skeletons under the global data directory. The example file is
never loaded, every response example is commented, and existing template files
are never overwritten. Their paths are returned to the desktop settings page
so users can copy only the examples they intend to activate.

`managed` is the configuration-owning module behind the desktop form. Its small
interface accepts a workspace and a managed-hook draft, then owns ID creation,
manifest validation, interpreter commands, safe no-op script creation, catalog
projection, and enabled-state filtering. It stores each definition at
`.tinybot/hooks/<id>/hook.json` beside `hook.ps1` or `hook.sh`. Updating the
manifest never overwrites an existing user script. Managed and hand-written
definitions converge before trust evaluation and command execution.

Managed hooks can be tested individually after they are enabled and trusted.
The backend builds a bounded sample for the hook's event, executes only that
definition, and returns structured decision and feedback fields without raw
stdout or stderr. Removal archives the complete managed-hook directory below
`.tinybot/hooks-archive` instead of deleting it.

Every handler is identified by a hash of its source path, event, matcher, and
complete command definition. Commands are skipped until that exact hash is
trusted in the global trust store. Editing a definition changes its hash and
requires another review. Hook processes inherit the desktop user's authority;
the Agent capability policy does not sandbox them.

The runner bounds stdin, stdout, and stderr, applies a timeout, and terminates
the process tree on timeout. Runtime events expose decisions and bounded
diagnostics without serializing command text or hook output.
