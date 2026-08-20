# Command Hooks
<!-- tinybot-module-fingerprint: sha256:f97bb076395b40648d928872672dcd10b3f519c2ce1bd7121d8f0d610e41ba2c -->

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

The same module owns inline managed-script editing. Callers identify a script
by workspace and managed ID rather than an arbitrary path. Reads validate the
manifest and filesystem containment and are limited to 256 KiB of UTF-8 text;
writes are atomic and require the exact content revision returned by the read,
so an external edit cannot be overwritten silently.

Every handler is identified by a hash of its source path, event, matcher, and
complete command definition. Commands are skipped until that exact hash is
trusted in the global trust store. A managed hook's script revision also
participates in this hash, and the runner revalidates that revision immediately
before execution. Editing either the definition or script therefore requires
another review. Hook processes inherit the desktop user's authority; the Agent
capability policy does not sandbox them.

The runner bounds stdin, stdout, and stderr and applies one deadline to process
execution and pipe draining. It terminates the complete process tree on timeout,
including through a Windows Job Object. Runtime events expose decisions and
bounded diagnostics without serializing command text or hook output.
