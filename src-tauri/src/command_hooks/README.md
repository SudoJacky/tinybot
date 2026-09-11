# Command Hooks
<!-- tinybot-module-fingerprint: sha256:f8c458082e41ef8d288903ab246726d6bb39ba9f46df82871a05ab6b031e6f7e -->

`command_hooks` discovers, validates, reviews, and runs user-defined lifecycle
commands. Tinybot loads `hooks.json` from the global data directory and the
active workspace's `.tinybot` directory. Sources are additive.

The application bridge loads the engine for each Turn and adapts it to the
runtime's asynchronous `AgentHook` interface. The Agent core receives neutral
effects and run diagnostics; it does not discover configuration or construct
command processes. Missing optional configuration is valid, but invalid
configuration or an unreadable trust store fails preparation with source
diagnostics. A newly started durable Turn is marked failed before any provider
request. Catalog inspection still returns diagnostics for the settings UI.

The first supported Codex-compatible events are `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, and `PostCompact`. Each command receives one JSON
object on stdin and returns event-specific JSON on stdout. Only synchronous
`type: "command"` handlers are accepted.

Action Fusion currently requires separate calls when an enabled, trusted PreToolUse
or PostToolUse handler matches exec_command. The bridge denies a fused patch before
editing and instructs the Agent to issue ordinary patch and Shell calls, preserving
each handler's input and execution stage.

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
